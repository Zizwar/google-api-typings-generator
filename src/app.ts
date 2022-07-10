import fs from 'node:fs';
import _ from 'lodash';
import path, {basename, join} from 'node:path';
import sortObject from 'deep-sort-object';
import {
  checkExists,
  ensureDirectoryExists,
  getAllNamespaces,
  getPackageName,
  getResourceTypeName,
  getRevision,
  parseVersion,
} from './utils.js';
import {StreamWriter, TextWriter} from './writer.js';
import {Template, TemplateData} from './template/index.js';
import {ProxySetting} from 'get-proxy-settings';
import {hasPrefixI} from './tslint.js';
import {
  fallbackDocumentationLinks,
  revisionPrefix,
  zeroWidthJoinerCharacter,
} from './constants.js';
import {fileURLToPath} from 'node:url';
import {getAllRestDescriptions} from './discovery.js';

type JsonSchema = gapi.client.discovery.JsonSchema;
type RestResource = gapi.client.discovery.RestResource;
type RestDescription = gapi.client.discovery.RestDescription;
type RestMethod = gapi.client.discovery.RestMethod;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const typesMap: {[key: string]: string} = {
  integer: 'number',
  object: 'any',
  any: 'any',
  string: 'string',
};

export const excludedRestDescriptionIds: NonNullable<RestDescription['id']>[] =
  ['apigee'];

const generatedDisclaimer = [
  'IMPORTANT',
  'This file was generated by https://github.com/Maxim-Mazurok/google-api-typings-generator. Please do not edit it manually.',
  'In case of any problems please post issue to https://github.com/Maxim-Mazurok/google-api-typings-generator',
];
const writeGeneratedDisclaimer = (writer: TypescriptTextWriter) =>
  generatedDisclaimer.map(line => writer.writeLine(`// ${line}`));

const irregularSpaces = [
  // eslint-disable-next-line no-control-regex
  /\u000B/g, // Line Tabulation (\v) - <VT>
  // eslint-disable-next-line no-control-regex
  /\u000C/g, // Form Feed (\f) - <FF>
  /\u00A0/g, // No-Break Space - <NBSP>
  /\u0085/g, // Next Line
  /\u1680/g, // Ogham Space Mark
  /\u180E/g, // Mongolian Vowel Separator - <MVS>
  /\ufeff/g, // Zero Width No-Break Space - <BOM>
  /\u2000/g, // En Quad
  /\u2001/g, // Em Quad
  /\u2002/g, // En Space - <ENSP>
  /\u2003/g, // Em Space - <EMSP>
  /\u2004/g, // Tree-Per-Em
  /\u2005/g, // Four-Per-Em
  /\u2006/g, // Six-Per-Em
  /\u2007/g, // Figure Space
  /\u2008/g, // Punctuation Space - <PUNCSP>
  /\u2009/g, // Thin Space
  /\u200A/g, // Hair Space
  /\u200B/g, // Zero Width Space - <ZWSP>
  /\u2028/g, // Line Separator
  /\u2029/g, // Paragraph Separator
  /\u202F/g, // Narrow No-Break Space
  /\u205f/g, // Medium Mathematical Space
  /\u3000/g, // Ideographic Space
];

const jsdocComment = {start: '/**', end: '*/'};

class IndentedTextWriter {
  constructor(
    private writer: TextWriter,
    public newLine = '\n',
    public tabString = '    '
  ) {}

  public indent = 0;

  write(chunk: string) {
    this.writer.write(chunk);
  }

  startIndentedLine(chunk = '') {
    this.write(Array(this.indent + 1).join(this.tabString) + chunk);
  }

  endIndentedLine(chunk = '') {
    this.write(chunk + Array(this.indent + 1).join(this.tabString));
  }

  writeLine(chunk = '') {
    this.startIndentedLine(chunk + this.newLine);
  }

  writeNewLine(chunk = '') {
    this.endIndentedLine(chunk + this.newLine);
  }

  async end() {
    await this.writer.end();
  }
}

interface TypescriptTextWriter {
  namespace(
    name: string,
    context: (writer: TypescriptTextWriter) => void
  ): void;
}

type TypescriptWriterCallback = (writer: TypescriptTextWriter) => void;

function formatPropertyName(name: string) {
  if (name.includes('.') || name.includes('-') || name.includes('@')) {
    return `"${name}"`;
  }
  return name;
}

class TypescriptTextWriter implements TypescriptTextWriter {
  private readonly ignoreBannedType = '// tslint:disable-next-line:ban-types';

  constructor(
    private readonly writer: IndentedTextWriter,
    private readonly maxLineLength: number,
    private readonly bannedTypes: string[]
  ) {}

  private braces(
    text: string,
    context: (writer: TypescriptTextWriter) => void
  ) {
    this.writer.writeLine(text + ' {');
    this.writer.indent++;
    context(this);
    this.writer.indent--;
    this.writer.writeLine('}');
  }

  private includesBannedType(type: string): boolean {
    return this.bannedTypes.some(bannedType =>
      type.match(new RegExp(`\\b${bannedType}\\b`))
    );
  }

  referenceTypes(type: string) {
    this.writer.writeLine(`/// <reference types="${type}" />`);
  }

  namespace(name: string, context: TypescriptWriterCallback) {
    this.braces(`namespace ${name}`, context);
  }

  declareNamespace(name: string, context: TypescriptWriterCallback) {
    this.writer.writeLine();
    this.braces(`declare namespace ${name}`, context);
  }

  interface(
    name: string,
    context: TypescriptWriterCallback,
    emptyInterface = false
  ) {
    const ignoreRules: string[] = [];
    if (hasPrefixI(name)) {
      // workaround for cases like `IPAllocationPolicy`
      ignoreRules.push('interface-name');
    }
    if (emptyInterface) {
      ignoreRules.push('no-empty-interface');
    }
    if (ignoreRules.length > 0) {
      this.writer.writeLine(
        `// tslint:disable-next-line:${ignoreRules.join(' ')}`
      );
    }
    this.braces(`interface ${name}`, context);
  }

  anonymousType(context: TypescriptWriterCallback) {
    this.endLine('{');
    this.writer.indent++;
    context(this);
    this.writer.indent--;
    this.writer.startIndentedLine('}');
  }

  newLine(chunk: string) {
    this.writer.startIndentedLine(chunk);
  }

  endLine(chunk = '') {
    this.writer.write(chunk);
    this.writer.write(this.writer.newLine);
  }

  scope(context: TypescriptWriterCallback, startTag = '{', endTag = '}') {
    this.writer.write(startTag);
    this.writer.write(this.writer.newLine);
    this.writer.indent++;
    context(this);
    this.writer.indent--;
    this.writer.startIndentedLine(endTag);
  }

  property(
    name: string,
    type: string | TypescriptWriterCallback,
    required = true
  ) {
    if (typeof type === 'function') {
      this.writer.startIndentedLine(
        `${formatPropertyName(name)}${required ? '' : '?'}: `
      );
      type(this);
      this.endLine(';');
    } else if (typeof type === 'string') {
      this.includesBannedType(type) &&
        this.writer.writeLine(this.ignoreBannedType);
      this.writer.writeLine(
        `${formatPropertyName(name)}${required ? '' : '?'}: ${type};`
      );
    }
  }

  comment(text = '') {
    if (!text || text.trim() === '') {
      return;
    }

    text = text.replace(/\*\//g, `*${zeroWidthJoinerCharacter}/`); // hack for `bla/*/bla` cases in comments
    // escape @class, @this, @type, @typedef and @property in JSDoc to fix no-redundant-jsdoc error
    text = text.replace(
      /@(class|this|type(?:def)?|property)/g,
      `@${zeroWidthJoinerCharacter}$1`
    );

    const maxLineLength =
      this.maxLineLength -
      this.writer.indent * this.writer.tabString.length -
      `${jsdocComment.start}  ${jsdocComment.end}`.length;

    let lines: string[] = [];

    for (const line of text.trim().split(/\r?\n/g)) {
      if (line.length > maxLineLength) {
        const words = line.split(' ');
        let newLine = '';

        for (const word of words) {
          if (newLine.length + ' '.length + word.length > maxLineLength) {
            lines.push(newLine);
            newLine = word;
          } else if (newLine === '') {
            newLine = word;
          } else {
            newLine += ' ' + word;
          }
        }

        lines.push(newLine);
      } else {
        lines.push(line);
      }
    }

    lines = lines.map(x => x.trim());

    for (const irregularSpace of irregularSpaces) {
      lines = lines.map(line => line.replace(irregularSpace, ' '));
    }

    const longestLineLength = Math.max(...lines.map(x => x.length));

    const extraLines: {prepend?: string; append?: string} = {};

    if (longestLineLength > maxLineLength) {
      // it's most likely has a URL that we shouldn't break
      extraLines.prepend = '// tslint:disable:max-line-length';
      extraLines.append = '// tslint:enable:max-line-length';
    }

    extraLines.prepend && this.writer.writeLine(extraLines.prepend);
    if (lines.length === 1) {
      this.writer.writeLine(
        `${jsdocComment.start} ${lines[0]} ${jsdocComment.end}`
      );
    } else if (lines.length > 1) {
      this.writer.writeLine(jsdocComment.start);
      _.forEach(lines, line =>
        line ? this.writer.writeLine(` * ${line}`) : this.writer.writeLine(' *')
      );
      this.writer.writeLine(` ${jsdocComment.end}`);
    }
    extraLines.append && this.writer.writeLine(extraLines.append);
  }

  method(
    name: string,
    parameters: Array<{
      parameter: string;
      type: string | TypescriptWriterCallback;
      required: boolean;
    }>,
    returnType: string,
    singleLine = false
  ) {
    const ignoreBannedReturnType = this.bannedTypes.some(bannedType =>
      returnType.match(new RegExp(`\\b${bannedType}\\b`))
    );
    if (singleLine && ignoreBannedReturnType) {
      this.writer.writeLine(this.ignoreBannedType);
    }

    this.writer.startIndentedLine(`${name}(`);

    _.forEach(parameters, (parameter, index) => {
      if (
        typeof parameter.type === 'string' &&
        this.includesBannedType(parameter.type)
      ) {
        this.writer.writeNewLine(this.ignoreBannedType);
      }
      this.write(`${parameter.parameter}${parameter.required ? '' : '?'}: `);
      this.write(parameter.type);

      if (index + 1 < parameters.length) {
        this.write(',');

        if (singleLine) {
          this.write(' ');
        } else {
          this.writeNewLine();
        }
      }
    });

    if (!singleLine && ignoreBannedReturnType) {
      this.writeNewLine();
      this.writeNewLine(this.ignoreBannedType);
    }

    this.writer.write(`): ${returnType};`);

    this.endLine();
  }

  writeLine(chunk = '') {
    this.writer.writeLine(chunk);
  }

  writeNewLine(chunk = '') {
    this.writer.writeNewLine(chunk);
  }

  write(chunk: string | TypescriptWriterCallback = '') {
    if (typeof chunk === 'string') {
      this.writer.write(chunk);
    } else if (typeof chunk === 'function') {
      chunk(this);
    }
  }

  async end() {
    await this.writer.end();
  }
}

function getName(path: string | undefined): string | undefined {
  if (!path) {
    return undefined;
  }
  const parts = path.split('.');

  if (parts.length > 0) {
    return _.last(parts);
  } else {
    return undefined;
  }
}

function getType(
  type: JsonSchema,
  schemas: Record<string, JsonSchema>
): string | TypescriptWriterCallback {
  if (type.type === 'array') {
    const child = getType(checkExists(type.items), schemas);

    if (typeof child === 'string') {
      return `${child}[]`;
    } else if (typeof child === 'function') {
      return (writer: TypescriptTextWriter) => {
        writer.write('Array<');
        child(writer);
        writer.write('>');
      };
    } else {
      return '[]';
    }
  } else if (type.type === 'object' && type.properties) {
    return (writer: TypescriptTextWriter) => {
      writer.anonymousType(() => {
        _.forEach(type.properties, (property, propertyName) => {
          if (property.description) {
            writer.comment(formatComment(property.description));
          }
          writer.property(
            propertyName,
            getType(property, schemas),
            property.required || false
          );
        });

        if (type.additionalProperties) {
          writer.property(
            '[key: string]',
            getType(type.additionalProperties, schemas)
          );
        }
      });
    };
  } else if (type.type === 'object' && type.additionalProperties) {
    return (writer: TypescriptTextWriter) => {
      const child = getType(checkExists(type.additionalProperties), schemas);
      // Record<K, T> (workaround for https://github.com/Maxim-Mazurok/google-api-typings-generator/issues/206)
      writer.write('{ [P in string]: ');
      writer.write(child);
      writer.write(' }');
    };
  } else if (type.type) {
    const tsType = typesMap[type.type] || type.type;
    return type.repeated ? `${tsType} | ${tsType}[]` : tsType;
  } else if (type.$ref) {
    const referencedType = schemas[type.$ref];

    if (isEmptySchema(referencedType)) {
      return 'any';
    }

    return type.$ref;
  } else throw Error();
}

function formatComment(comment: string) {
  if (!comment) return '';

  return comment;
}

function getMethodReturn(
  method: RestMethod,
  schemas: Record<string, JsonSchema>
) {
  const name = schemas['Request'] ? 'client.Request' : 'Request';

  if (method.response) {
    const schema = schemas[checkExists(method.response.$ref)];

    if (schema && !_.isEmpty(schema.properties)) {
      return `${name}<${method.response.$ref}>`;
    } else {
      return `${name}<{}>`;
    }
  } else {
    return `${name}<void>`;
  }
}

const readmeTpl = new Template('readme.dot');
const tsconfigTpl = new Template('tsconfig.dot');
const tslintTpl = new Template('tslint.dot');
const packageJsonTpl = new Template('package-json.dot');

function isEmptySchema(schema: JsonSchema) {
  return _.isEmpty(schema.properties) && !schema.additionalProperties;
}

export interface Configuration {
  discoveryJsonDirectory?: string; // temporary directory to cache discovery service JSON
  proxy?: ProxySetting;
  typesDirectory: string;
  maxLineLength: number;
  bannedTypes: string[];
  owners: string[];
}

export class App {
  private seenSchemaRefs: Set<string> = new Set();

  constructor(private readonly config: Configuration) {
    ensureDirectoryExists(config.typesDirectory);

    console.log(`types directory: ${config.typesDirectory}`);
    console.log();
  }

  static parseOutPath(dir: string) {
    ensureDirectoryExists(dir);

    return dir;
  }

  /**
   * Creates a callback that writes request parameters.
   */
  private static createRequestParameterWriterCallback(
    parameters: Record<string, JsonSchema>,
    schemas: Record<string, JsonSchema>,
    ref?: string
  ) {
    return function requestParameterWriterCallback(
      writer: TypescriptTextWriter
    ) {
      writer.anonymousType(() => {
        _.forEach(parameters, (data, key) => {
          if (data.description) {
            writer.comment(formatComment(data.description));
          }

          writer.property(key, getType(data, schemas), Boolean(data.required));
        });

        if (ref) {
          writer.comment('Request body');
          writer.property('resource', ref, true);
        }
      });
    };
  }

  /**
   * Writes specified resource definition.
   */
  private writeResources(
    out: TypescriptTextWriter,
    resources: Record<string, RestResource>,
    parameters: Record<string, JsonSchema> = {},
    schemas: Record<string, JsonSchema>,
    namespace: string
  ): string[] {
    const writtenTopLevelResourceNames: string[] = [];

    _.forEach(resources, (resource, resourceName) => {
      const resourceInterfaceName = getResourceTypeName(resourceName);

      if (resource.resources !== undefined) {
        this.writeResources(
          out,
          resource.resources,
          parameters,
          schemas,
          namespace
        );
      }

      const allMethods = Object.entries(resource.methods || {});

      const methods = allMethods.filter(([, method]) =>
        checkExists(method.id).startsWith(`${namespace}.`)
      );

      const supposedToBeEmpty =
        allMethods.length === 0 &&
        (resource.resources === undefined ||
          Object.keys(resource.resources).length === 0);

      if (!supposedToBeEmpty && methods.length === 0) {
        // this interface isn't supposed to be empty and it doesn't have any methods in this namespace - so don't print it
        return;
      }

      out.interface(resourceInterfaceName, () => {
        writtenTopLevelResourceNames.push(resourceName);
        methods.forEach(([methodName, method]) => {
          if (method.description) {
            out.comment(formatComment(method.description));
          }

          const requestRef = method.request?.$ref;
          const requestParameters: Record<string, JsonSchema> = sortObject({
            ...parameters,
            ...method.parameters,
          });

          if (!requestParameters.resource || !requestRef) {
            // generate method(request)
            out.method(
              formatPropertyName(checkExists(getName(methodName))),
              [
                {
                  parameter: 'request',
                  type: App.createRequestParameterWriterCallback(
                    requestParameters,
                    schemas,
                    requestRef
                  ),
                  required: Boolean(requestRef),
                },
              ],
              getMethodReturn(method, schemas)
            );
          }

          if (requestRef) {
            // generate method(request, body)
            out.method(
              formatPropertyName(checkExists(getName(methodName))),
              [
                {
                  parameter: 'request',
                  type: App.createRequestParameterWriterCallback(
                    requestParameters,
                    schemas
                  ),
                  required: true,
                },
                {
                  parameter: 'body',
                  type: requestRef,
                  required: true,
                },
              ],
              getMethodReturn(method, schemas)
            );
          }
        });

        if (resource.resources) {
          _.forEach(resource.resources, (_, childResourceName) => {
            const childResourceInterfaceName =
              getResourceTypeName(childResourceName);
            out.property(childResourceName, childResourceInterfaceName);
          });
        }
      });
    });

    return _.uniq(writtenTopLevelResourceNames).sort();
  }

  /// writes api description for specified JSON object
  private async processApi(
    destinationDirectory: string,
    restDescription: RestDescription,
    restDescriptionSource: URL,
    namespaces: string[]
  ) {
    console.log(
      `Generating ${restDescription.id} definitions... ${
        (restDescription.labels && restDescription.labels.join(', ')) || ''
      }`
    );

    const stream = fs.createWriteStream(
      path.join(destinationDirectory, 'index.d.ts')
    );
    const writer = new TypescriptTextWriter(
      new IndentedTextWriter(new StreamWriter(stream)),
      this.config.maxLineLength,
      this.config.bannedTypes
    );

    writer.writeLine(
      `/* Type definitions for non-npm package ${checkExists(
        restDescription.title
      )} ${restDescription.version} ${parseVersion(
        checkExists(restDescription.version)
      )} */`
    );
    writer.writeLine(`// Project: ${restDescription.documentationLink}`);
    this.config.owners.forEach((owner, index) =>
      writer.writeLine(
        index === 0
          ? `// Definitions by: ${owner}`
          : `//                 ${owner}`
      )
    );

    writer.writeLine(
      '// Definitions: https://github.com/DefinitelyTyped/DefinitelyTyped'
    );
    writer.writeLine('// TypeScript Version: 2.8');
    writer.writeLine();
    writeGeneratedDisclaimer(writer);
    writer.writeLine(`// Generated from: ${restDescriptionSource}`);
    writer.writeLine(`${revisionPrefix}${restDescription.revision}`);
    writer.writeLine();
    writer.referenceTypes('gapi.client');

    // write main namespace
    writer.declareNamespace('gapi.client', () => {
      writer.comment(
        formatComment(
          `Load ${restDescription.title} ${restDescription.version}`
        )
      );

      writer.method(
        'function load',
        [
          {
            parameter: 'urlOrObject',
            type: `"${restDescriptionSource}"`,
            required: true,
          },
        ],
        'PromiseLike<void>',
        true
      );

      writer.comment('@deprecated Please load APIs with discovery documents.');

      writer.method(
        'function load',
        [
          {
            parameter: 'name',
            type: `"${restDescription.name}"`,
            required: true,
          },
          {
            parameter: 'version',
            type: `"${restDescription.version}"`,
            required: true,
          },
        ],
        'PromiseLike<void>',
        true
      );

      writer.comment('@deprecated Please load APIs with discovery documents.');

      writer.method(
        'function load',
        [
          {
            parameter: 'name',
            type: `"${restDescription.name}"`,
            required: true,
          },
          {
            parameter: 'version',
            type: `"${restDescription.version}"`,
            required: true,
          },
          {parameter: 'callback', type: '() => any', required: true},
        ],
        'void',
        true
      );

      // expose root resources to gapi.client namespace

      writer.endLine();

      namespaces.forEach(namespace => {
        writer.namespace(namespace, () => {
          const schemas = checkExists(restDescription.schemas);

          _.forEach(schemas, schema => {
            writer.interface(
              checkExists(schema.id),
              () => {
                if (schema.properties) {
                  _.forEach(schema.properties, (data, key) => {
                    if (data.description) {
                      writer.comment(formatComment(data.description));
                    }
                    writer.property(
                      key,
                      getType(data, schemas),
                      data.required || false
                    );
                  });
                }

                if (schema.additionalProperties) {
                  writer.property(
                    '[key: string]',
                    getType(schema.additionalProperties, schemas)
                  );
                }
              },
              isEmptySchema(schema)
            );
          });

          if (restDescription.resources) {
            const writtenResources = this.writeResources(
              writer,
              restDescription.resources,
              restDescription.parameters,
              schemas,
              namespace
            );

            writtenResources.forEach(resourceName => {
              if (resourceName !== 'debugger') {
                writer.endLine();
                writer.writeLine(
                  `const ${resourceName}: ${getResourceTypeName(resourceName)};`
                );
              }
            });
          }
        });
      });
    });

    await writer.end();
  }

  async processService(
    restDescription: RestDescription,
    restDescriptionSource: URL,
    newRevisionsOnly = false
  ) {
    restDescription = sortObject(restDescription);
    restDescription.id = checkExists(restDescription.id);
    restDescription.name = checkExists(restDescription.name);
    const packageName = getPackageName(restDescription);

    console.log(`Processing service with ID ${restDescription.id}...`);

    restDescription.documentationLink =
      restDescription.documentationLink ||
      fallbackDocumentationLinks[restDescription.id];

    if (!restDescription.documentationLink) {
      throw `No documentationLink found for service with ID ${restDescription.id}, can't write required Project header, aborting`;
    }

    const destinationDirectory = path.join(
      this.config.typesDirectory,
      packageName
    );

    if (this.config.discoveryJsonDirectory) {
      fs.writeFileSync(
        join(
          this.config.discoveryJsonDirectory,
          `${basename(destinationDirectory)}.json`
        ),
        JSON.stringify(restDescription)
      );
    }

    ensureDirectoryExists(destinationDirectory);
    const indexDTSPath = path.join(destinationDirectory, 'index.d.ts');

    if (newRevisionsOnly && fs.existsSync(indexDTSPath)) {
      if (!restDescription.revision) {
        return console.error(
          `There's no revision in JSON of service with ID: ${restDescription.id}`
        );
      }

      let existingRevision = getRevision(indexDTSPath);

      if (!existingRevision) {
        console.error(
          `Can't find previous revision in index.d.ts: ${restDescription.id}`
        );
        existingRevision = Infinity; // to avoid loop that happened with compute:v1, always update when can't find previous revision
      }

      const newRevision = Number(restDescription.revision);
      if (existingRevision > newRevision) {
        return console.warn(
          `Local revision ${existingRevision} is more recent than fetched ${newRevision}, skipping ${restDescription.id}`
        );
      }
    }

    const namespaces = getAllNamespaces(restDescription);

    await this.processApi(
      destinationDirectory,
      restDescription,
      restDescriptionSource,
      namespaces
    );

    const templateData: TemplateData = {
      restDescription,
      restDescriptionSource: restDescriptionSource.toString(),
      namespaces,
      majorAndMinorVersion: parseVersion(checkExists(restDescription.version)),
      packageName,
    };

    await readmeTpl.write(
      path.join(destinationDirectory, 'readme.md'),
      templateData
    );
    await tsconfigTpl.write(
      path.join(destinationDirectory, 'tsconfig.json'),
      templateData
    );
    await tslintTpl.write(
      path.join(destinationDirectory, 'tslint.json'),
      templateData
    );
    await packageJsonTpl.write(
      path.join(destinationDirectory, 'package.json'),
      templateData
    );
    fs.copyFileSync(
      path.join(__dirname, 'template', '.npmrc'),
      path.join(destinationDirectory, '.npmrc')
    );

    await this.writeTests(
      destinationDirectory,
      restDescription,
      restDescriptionSource,
      namespaces
    );
  }

  private writePropertyValue(
    scope: TypescriptTextWriter,
    api: RestDescription,
    property: JsonSchema
  ) {
    switch (property.type) {
      case 'number':
      case 'integer':
        scope.write('42');
        break;
      case 'boolean':
        scope.write('true');
        break;
      case 'string':
        scope.write('"Test string"');
        break;
      case 'array':
        this.writeArray(scope, api, checkExists(property.items));
        break;
      case 'object':
        this.writeObject(scope, api, property);
        break;
      case 'any':
        scope.write('42');
        break;
      default:
        throw new Error(`Unknown scalar type ${property.type}`);
    }
  }

  private writeArray(
    scope: TypescriptTextWriter,
    api: RestDescription,
    items: JsonSchema
  ) {
    const schemaName = items.$ref;
    if (schemaName && this.seenSchemaRefs.has(schemaName)) {
      // Break out of recursive reference by writing undefined
      scope.write('undefined');
      return;
    }

    scope.scope(
      () => {
        scope.newLine('');
        if (schemaName) {
          this.writeSchemaRef(scope, api, schemaName);
        } else {
          this.writePropertyValue(scope, api, items);
        }
      },
      '[',
      ']'
    );
  }

  private writeObject(
    scope: TypescriptTextWriter,
    api: RestDescription,
    object: JsonSchema
  ) {
    const schemaName = object.additionalProperties?.$ref;
    if (schemaName && this.seenSchemaRefs.has(schemaName)) {
      scope.write('undefined');
      return;
    }
    if (object.properties) {
      // If the object has properties, only write that structure
      scope.scope(() => {
        this.writeProperties(scope, api, object.properties!);
      });
      return;
    } else if (object.additionalProperties) {
      // Otherwise, we have a Record<K, V> and we should write a placeholder key
      scope.scope(() => {
        scope.newLine('A: ');
        if (schemaName) {
          this.writeSchemaRef(scope, api, schemaName);
        } else {
          this.writePropertyValue(scope, api, object.additionalProperties!);
        }
      });
    } else {
      this.writePropertyValue(scope, api, object);
    }
  }

  // Performs a lookup of the specified interface/schema type and recursively generates stubbed values
  private writeSchemaRef(
    scope: TypescriptTextWriter,
    api: RestDescription,
    schemaName: string
  ) {
    if (this.seenSchemaRefs.has(schemaName)) {
      // Break out of recursive reference by writing undefined
      scope.write('undefined');
      return;
    }

    const schema = checkExists(api.schemas)[schemaName];
    if (!schema) {
      throw new Error(
        `Attempted to generate stub for unknown schema '${schemaName}'`
      );
    }

    this.seenSchemaRefs.add(schemaName);
    this.writeObject(scope, api, schema);
    this.seenSchemaRefs.delete(schemaName);
  }

  private writeProperties(
    scope: TypescriptTextWriter,
    api: RestDescription,
    record: Record<string, JsonSchema>
  ) {
    _.forEach(record, (parameter, name) => {
      scope.newLine(`${formatPropertyName(name)}: `);
      if (parameter.type === 'object') {
        this.writeObject(scope, api, parameter);
      } else if (parameter.$ref) {
        this.writeSchemaRef(scope, api, parameter.$ref);
      } else {
        this.writePropertyValue(scope, api, parameter);
      }
      scope.endLine(',');
    });
  }

  private writeResourceTests(
    scope: TypescriptTextWriter,
    api: RestDescription,
    ancestors: string,
    resourceName: string,
    resource: RestResource,
    namespace: string
  ) {
    _.forEach(resource.methods, (method, methodName) => {
      if (
        checkExists(method.id)
          .replace(/^gapi\.client\./, '')
          .startsWith(namespace) === false
      ) {
        return;
      }

      scope.comment(method.description);
      scope.newLine(`await ${ancestors}.${resourceName}.${methodName}(`);

      const params: Record<string, JsonSchema> | undefined = method.parameters;
      const ref = method.request?.$ref;

      if (params) {
        scope.scope(() => {
          this.writeProperties(scope, api, params);
        });
      }

      if (ref) {
        if (!params) {
          scope.write('{} ');
        }

        scope.write(', ');

        this.writeSchemaRef(scope, api, ref);
      }

      scope.endLine(');');

      _.forEach(resource.resources, (subResource, subResourceName) => {
        this.writeResourceTests(
          scope,
          api,
          `${ancestors}.${resourceName}`,
          subResourceName,
          subResource,
          namespace
        );
      });
    });
  }

  private async writeTests(
    destinationDirectory: string,
    api: RestDescription,
    restDescriptionSource: URL,
    namespaces: string[]
  ) {
    const packageName = getPackageName(api);

    const stream = fs.createWriteStream(
        path.join(destinationDirectory, 'tests.ts')
      ),
      writer = new TypescriptTextWriter(
        new IndentedTextWriter(new StreamWriter(stream)),
        this.config.maxLineLength,
        this.config.bannedTypes
      );

    writer.writeLine(
      `/* This is stub file for ${packageName} definition tests */`
    );
    writeGeneratedDisclaimer(writer);
    writer.writeLine();
    writer.writeLine(`${revisionPrefix}${api.revision}`);
    writer.writeLine();
    writer.newLine("gapi.load('client', async () => ");
    writer.scope(writer3 => {
      writer3.comment('now we can use gapi.client');
      writer3.endLine();
      writer3.writeLine(`await gapi.client.load('${restDescriptionSource}');`);
      writer3.comment(
        `now we can use ${namespaces.map(x => `gapi.client.${x}`).join(', ')}`
      );
      writer3.endLine();
      if (api.auth) {
        writer3.comment(
          "don't forget to authenticate your client before sending any request to resources:"
        );
        writer3.comment(
          'declare client_id registered in Google Developers Console'
        );

        writer3.writeLine("const client_id = '<<PUT YOUR CLIENT ID HERE>>';");
        writer3.newLine('const scope = ');
        writer3.scope(
          () => {
            const oauth2 = checkExists(api?.auth?.oauth2);
            _.forEach(oauth2.scopes, (value, scope) => {
              writer3.comment(value.description);
              writer3.writeLine(`'${scope}',`);
            });
          },
          '[',
          ']'
        );

        writer3.endLine(';');
        writer3.writeLine('const immediate = false;');
        writer3.newLine(
          'gapi.auth.authorize({ client_id, scope, immediate }, authResult => '
        );

        writer3.scope(scope => {
          writer3.newLine('if (authResult && !authResult.error) ');
          scope.scope(a => {
            a.comment('handle successful authorization');
            a.writeLine('run();');
          });
          scope.write(' else ');
          scope.scope(() => {
            scope.comment('handle authorization error');
          });
          writer3.endLine();
        });

        writer3.endLine(');');
      } else {
        writer3.writeLine('run();');
      }

      writer3.endLine();
      writer3.newLine('async function run() ');
      writer.scope(scope => {
        namespaces.forEach(namespace => {
          _.forEach(api.resources, (resource, resourceName) => {
            this.writeResourceTests(
              scope,
              api,
              `gapi.client.${namespace}`,
              resourceName,
              resource,
              namespace
            );
          });
        });
      });

      writer3.endLine();
    });
    writer.endLine(');');
    await writer.end();
  }

  async discover(service: string | undefined, newRevisionsOnly = false) {
    console.log('Discovering Google services...');

    const restDescriptions = (await getAllRestDescriptions(this.config.proxy))
      .filter(({restDescription}) =>
        service ? restDescription.name === service : true
      )
      .filter(
        ({restDescription}) =>
          !excludedRestDescriptionIds.includes(checkExists(restDescription.id))
      );

    if (restDescriptions.length === 0) {
      throw Error("Can't find services");
    }

    for (const {restDescription, restDescriptionSource} of restDescriptions) {
      // do not call processService() in parallel, Google used to be able to handle this, but not anymore

      try {
        await this.processService(
          restDescription,
          restDescriptionSource,
          newRevisionsOnly
        );
      } catch (e) {
        console.error(e);
        throw Error(`Error processing service: ${restDescription.name}`);
      }
    }
  }
}
