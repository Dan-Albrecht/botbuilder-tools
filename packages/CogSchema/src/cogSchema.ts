#!/usr/bin/env node
/**
 * Copyright(c) Microsoft Corporation.All rights reserved.
 * Licensed under the MIT License.
 */
// tslint:disable:no-console
// tslint:disable:no-object-literal-type-assertion
import * as chalk from 'chalk';
import * as fs from 'fs-extra';
import * as glob from 'globby';
import * as lgt from '../../CogLint/src/lgTracker';
import * as path from 'path';
import * as process from 'process';
import * as program from 'commander';
import * as semver from 'semver';
import * as st from '../../CogLint/src/schemaTracker';
import * as Validator from 'ajv';
let allof: any = require('json-schema-merge-allof');
let clone = require('clone');
let parser: any = require('json-schema-ref-parser');

// tslint:disable-next-line:no-let-requires no-require-imports
const pkg: IPackage = require('../../../package.json');
const requiredVersion: string = pkg.engines.node;
if (!semver.satisfies(process.version, requiredVersion)) {
    console.error(`Required node version ${requiredVersion} not satisfied with current version ${process.version}.`);
    process.exit(1);
}

program.Command.prototype.unknownOption = (flag: string): void => {
    console.error(chalk.default.redBright(`Unknown arguments: ${flag}`));
    program.outputHelp((str: string) => {
        console.error(chalk.default.redBright(str));
        return '';
    });
    process.exit(1);
};

function parseBool(val?: string): boolean {
    return val === "true";
}

program
    .version(pkg.version, '-v, --Version')
    .usage("[options] <fileRegex ...>")
    .option("-o, output <path>", "Output path and filename for unified schema and associated .lg files per locale.")
    .option("-f, flat [boolean]", "Use flat (true) or hierarchical (false) naming for templates, default is true if present, otherwise use format found in output file if present.", parseBool)
    .description(`Take JSON Schema files and merge them into a single schema file where $ref are included and allOf are merged. Will also use $role to define union types.  All associated .lg files will be merged into a single .lg file per locale.  See readme.md for more information.`)
    .parse(process.argv);

let failed = false;
mergeSchemas();

// NOTE: This relies on an internal copy of cogSchema.schema which is generated by deleting the old file 
// and then running this which will pull in the standard meta-schema from the web.
async function mergeSchemas() {
    let schemaPaths = await glob(program.args);
    if (schemaPaths.length == 0) {
        program.help();
    }
    else {
        let progress = (msg: string) => console.log(chalk.default.grey(msg));
        let warning = (msg: string) => console.log(chalk.default.yellowBright(msg));
        let result = (msg: string) => console.log(msg);
        let definitions: any = {};
        let validator = new Validator();
        let metaSchema = await getMetaSchema();
        validator.addSchema(metaSchema, 'cogSchema');
        for (let schemaPath of schemaPaths) {
            progress(`Parsing ${schemaPath}`);
            try {
                let schema = allof(await parser.dereference(schemaPath));
                if (schema.$id) {
                    warning(`  Skipping because of top-level $id:${schema.$id}.`);
                } else {
                    delete schema.$schema;
                    if (!validator.validate('cogSchema', schema)) {
                        for (let error of <Validator.ErrorObject[]>validator.errors) {
                            schemaError(error);
                        }
                    }
                    let filename = <string>schemaPath.split(/[\\\/]/).pop();
                    let type = filename.substr(0, filename.lastIndexOf("."));
                    if (!schema.type && !isUnionType(schema)) {
                        schema.type = "object";
                    }
                    definitions[type] = schema;
                }
            } catch (e) {
                thrownError(e);
            }
        }
        fixDefinitionReferences(definitions);
        processRoles(definitions, metaSchema);
        addTypeTitles(definitions);
        expandTypes(definitions);
        addStandardProperties(definitions, metaSchema);
        sortUnions(definitions);
        if (!program.output) {
            program.output = "app.schema";
        }
        let finalDefinitions: any = {};
        for (let key of Object.keys(definitions).sort()) {
            finalDefinitions[key] = definitions[key];
        }
        let finalSchema = {
            $schema: metaSchema.$id,
            $id: path.basename(program.output),
            type: "object",
            title: "Component types",
            description: "These are all of the types that can be created by the loader.",
            oneOf: Object.keys(definitions)
                .filter((schemaName) => !isUnionType(definitions[schemaName]))
                .sort()
                .map((schemaName) => {
                    return {
                        title: schemaName,
                        description: definitions[schemaName].description || "",
                        $ref: "#/definitions/" + schemaName
                    };
                }),
            definitions: finalDefinitions
        };

        if (!failed) {
            result(`Writing ${program.output}`);
            await fs.writeJSON(program.output, finalSchema, { spaces: 4 });
            console.log("");
            progress("Generating .lg files");
            let schema = new st.schemaTracker();
            await schema.getValidator(program.output);
            let lg = new lgt.LGTracker(schema);
            for (let schemaPath of schemaPaths) {
                await lg.addLGFiles([path.join(path.dirname(schemaPath), path.basename(schemaPath, ".schema") + "*.lg")], progress);
            }
            for (let multiple of lg.multiplyDefined()) {
                let template0 = multiple[0];
                let desc = `${template0.name} has multiple definitions: `;
                for (let template of multiple) {
                    desc += ` ${template.file}:${template.line}`;
                }
                warning(desc);
            }
            await lg.writeFiles(path.join(path.dirname(program.output), path.basename(program.output, ".schema") + ".lg"), program.flat, result);
        } else {
            console.log(chalk.default.redBright("Could not merge schemas"));
        }
    }
}

async function getMetaSchema(): Promise<any> {
    let metaSchema: any;
    let schemaName = path.join(__dirname, "../../../src/cogSchema.schema");
    if (!await fs.pathExists(schemaName)) {
        console.log("Generating cogSchema.schema");
        let baseName = path.join(__dirname, "../../../src/baseCogSchema.schema");
        let schema = await fs.readJSON(baseName);
        let metaSchemaName = schema.$schema;
        metaSchema = JSON.parse(await getURL(metaSchemaName));
        for (let prop in schema) {
            let propDef = schema[prop];
            if (typeof propDef === "string") {
                metaSchema[prop] = propDef;
            } else {
                for (let subProp in propDef) {
                    metaSchema[prop][subProp] = propDef[subProp];
                }
            }
        }
        metaSchema.$comment = "This file is generated by running the cogSchema node tool when there is not a cogSchema.schema file.";
        await fs.writeJSON(schemaName, metaSchema, { spaces: 4 });
    } else {
        metaSchema = await fs.readJSON(schemaName);
    }
    return metaSchema;
}

function processRoles(definitions: any, metaSchema: any): void {
    for (let type in definitions) {
        walkJSON(definitions[type], (val: any, _obj, key) => {
            if (val.$role) {
                if (typeof val.$role === "string") {
                    processRole(val.$role, val, type, definitions, metaSchema, key);
                } else {
                    for (let role of val.$role) {
                        processRole(role, val, type, definitions, metaSchema, key);
                    }
                }
            }
            return false;
        });
    }
}

function processRole(role: string, elt: any, type: string, definitions: any, metaSchema: any, key?: string): void {
    const prefix = "unionType(";
    if (role === "lg") {
        if (!key) {
            errorMsg(type, "lg $role must be in a property defnition.");
        }
        if (elt.type) {
            errorMsg(type, `$role:lg should not have a type.`);
        }
        for (let prop in metaSchema.definitions.lg) {
            elt[prop] = metaSchema.definitions.lg[prop];
        }
    } else if (role === "unionType") {
        if (key) {
            errorMsg(type, "unionType $role can only be defined at the top of the schema definition.");
        }
    } else if (role.startsWith(prefix) && role.endsWith(")")) {
        let unionType = role.substring(prefix.length, role.length - 1);
        if (!definitions[unionType]) {
            errorMsg(type, `union type ${unionType} is not defined.`);
        } else if (!isUnionType(definitions[unionType])) {
            errorMsg(unionType, `is missing $role of unionType.`);
        } else {
            let definition = definitions[type];
            let unionDefinition = definitions[unionType];
            if (!unionDefinition.oneOf) {
                unionDefinition.oneOf = [];
            }
            unionDefinition.oneOf.push({
                title: type,
                description: definition.description || "",
                $ref: `#/definitions/${type}`
            });
        }
    }
}

function addTypeTitles(definitions: any): void {
    walkJSON(definitions, (val) => {
        if (val.oneOf) {
            walkJSON(val.oneOf, (def) => {
                if (def.type) {
                    // NOTE: This overrides any existing title but prevents namespace collision
                    def.title = def.type;
                }
                return false;
            });
        }
        return false;
    });
}

function fixDefinitionReferences(definitions: any): void {
    for (let type in definitions) {
        walkJSON(definitions[type], (val: any) => {
            if (val.$ref) {
                let ref: string = val.$ref;
                if (ref.startsWith("#/definitions/")) {
                    val.$ref = "#/definitions/" + type + "/definitions" + ref.substr(ref.indexOf('/'));
                }
            }
            return false;
        });
    }
}

function expandTypes(definitions: any): void {
    walkJSON(definitions, (val) => {
        if (val.$type) {
            if (definitions.hasOwnProperty(val.$type)) {
                val.$ref = "#/definitions/" + val.$type;
            } else {
                missing(val.$type);
            }
        }
        return false;
    });
}

function addStandardProperties(definitions: any, cogSchema: any): void {
    for (let type in definitions) {
        let definition = definitions[type];
        if (!isUnionType(definition)) {
            // Reorder properties to put $ first.
            let props: any = {
                $type: clone(cogSchema.definitions.type),
                $copy: cogSchema.definitions.copy,
                $id: cogSchema.definitions.id
            };
            props.$type.const = type;
            if (definition.properties) {
                for (let prop in definition.properties) {
                    props[prop] = definition.properties[prop];
                }
            }
            definition.properties = props;
            definition.additionalProperties = false;
            definition.patternProperties = { "^\\$": { type: "string" } };
            if (definition.required) {
                let required = definition.required;
                definition.required = ["$type"];
                definition.anyOf = [
                    {
                        title: "Reference",
                        required: ["$copy"]
                    },
                    {
                        title: "Type",
                        required: required
                    }
                ];
            } else {
                definition.required = ["$type"];
            }
        }
    }
}

function sortUnions(definitions: any): void {
    for (let key in definitions) {
        let definition = definitions[key];
        if (isUnionType(definition) && definition.oneOf) {
            definition.oneOf = definition.oneOf.sort((a: any, b: any) => a.title.localeCompare(b.title));
        }
    }
}

function walkJSON(elt: any, fun: (val: any, obj?: any, key?: string) => boolean, obj?: any, key?: any): boolean {
    let done = fun(elt, obj, key);
    if (!done) {
        if (Array.isArray(elt)) {
            for (let val of elt) {
                done = walkJSON(val, fun);
                if (done) break;
            }
        }
        else if (typeof elt === 'object') {
            for (let val in elt) {
                done = walkJSON(elt[val], fun, elt, val);
                if (done) break;
            }
        }
    }
    return done;
}

async function getURL(url: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const http = require('http'),
            https = require('https');

        let client = http;

        if (url.toString().indexOf("https") === 0) {
            client = https;
        }

        client.get(url, (resp: any) => {
            let data = '';

            // A chunk of data has been recieved.
            resp.on('data', (chunk: any) => {
                data += chunk;
            });

            // The whole response has been received. 
            resp.on('end', () => {
                resolve(data);
            });

        }).on("error", (err: any) => {
            reject(err);
        });
    });
};

function isUnionType(schema: any): boolean {
    return schema.$role === "unionType";
}

let missingTypes = new Set();
function missing(type: string): void {
    if (!missingTypes.has(type)) {
        console.log(chalk.default.redBright("Missing " + type + " schema file from merge."));
        missingTypes.add(type);
        failed = true;
    }
}

function schemaError(error: Validator.ErrorObject): void {
    console.log(chalk.default.redBright(`  ${error.dataPath} ${error.message}`));
    failed = true;
}

function thrownError(error: Error): void {
    console.log(chalk.default.redBright("  " + error.message));
    failed = true;
}

function errorMsg(type: string, message: string): void {
    console.log(chalk.default.redBright(`${type}: ${message}`));
    failed = true;
}

interface IPackage {
    version: string;
    engines: { node: string };
}

