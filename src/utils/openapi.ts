import { dirname } from 'path';

import { OpenAPIParser } from '../services/OpenAPIParser';
import {
  OpenAPIEncoding,
  OpenAPIMediaType,
  OpenAPIOperation,
  OpenAPIParameter,
  OpenAPISchema,
  OpenAPIServer,
  Referenced,
} from '../types';
import { IS_BROWSER } from './dom';
import { isNumeric, resolveUrl } from './helpers';

function isWildcardStatusCode(statusCode: string | number): statusCode is string {
  return typeof statusCode === 'string' && /\dxx/i.test(statusCode);
}

export function isStatusCode(statusCode: string) {
  return statusCode === 'default' || isNumeric(statusCode) || isWildcardStatusCode(statusCode);
}

export function getStatusCodeType(statusCode: string | number, defaultAsError = false): string {
  if (statusCode === 'default') {
    return defaultAsError ? 'error' : 'success';
  }

  let code = typeof statusCode === 'string' ? parseInt(statusCode, 10) : statusCode;
  if (isWildcardStatusCode(statusCode)) {
    code *= 100; // parseInt('2xx') parses to 2
  }

  if (code < 100 || code > 599) {
    throw new Error('invalid HTTP code');
  }
  let res = 'success';
  if (code >= 300 && code < 400) {
    res = 'redirect';
  } else if (code >= 400) {
    res = 'error';
  } else if (code < 200) {
    res = 'info';
  }
  return res;
}

const operationNames = {
  get: true,
  post: true,
  put: true,
  head: true,
  patch: true,
  delete: true,
  options: true,
};

export function isOperationName(key: string): boolean {
  return key in operationNames;
}

export function getOperationSummary(operation: OpenAPIOperation): string {
  return (
    operation.summary ||
    operation.operationId ||
    (operation.description && operation.description.substring(0, 50)) ||
    '<no summary>'
  );
}

const schemaKeywordTypes = {
  multipleOf: 'number',
  maximum: 'number',
  exclusiveMaximum: 'number',
  minimum: 'number',
  exclusiveMinimum: 'number',

  maxLength: 'string',
  minLength: 'string',
  pattern: 'string',

  items: 'array',
  maxItems: 'array',
  minItems: 'array',
  uniqueItems: 'array',

  maxProperties: 'object',
  minProperties: 'object',
  required: 'object',
  additionalProperties: 'object',
  properties: 'object',
};

export function detectType(schema: OpenAPISchema): string {
  if (schema.type !== undefined) {
    return schema.type;
  }
  const keywords = Object.keys(schemaKeywordTypes);
  for (const keyword of keywords) {
    const type = schemaKeywordTypes[keyword];
    if (schema[keyword] !== undefined) {
      return type;
    }
  }

  return 'any';
}

export function isPrimitiveType(schema: OpenAPISchema, type: string | undefined = schema.type) {
  if (schema.oneOf !== undefined || schema.anyOf !== undefined) {
    return false;
  }

  if (type === 'object') {
    return schema.properties !== undefined
      ? Object.keys(schema.properties).length === 0
      : schema.additionalProperties === undefined;
  }

  if (type === 'array') {
    if (schema.items === undefined) {
      return true;
    }
    return false;
  }

  return true;
}

export function isJsonLike(contentType: string): boolean {
  return contentType.search(/json/i) !== -1;
}

export function isFormUrlEncoded(contentType: string): boolean {
  return contentType === 'application/x-www-form-urlencoded';
}

function formEncodeField(fieldVal: any, fieldName: string, explode: boolean): string {
  if (!fieldVal || !fieldVal.length) {
    return fieldName + '=';
  }

  if (Array.isArray(fieldVal)) {
    if (explode) {
      return fieldVal.map(val => `${fieldName}=${val}`).join('&');
    } else {
      return fieldName + '=' + fieldVal.map(val => val.toString()).join(',');
    }
  } else if (typeof fieldVal === 'object') {
    if (explode) {
      return Object.keys(fieldVal)
        .map(k => `${k}=${fieldVal[k]}`)
        .join('&');
    } else {
      return (
        fieldName +
        '=' +
        Object.keys(fieldVal)
          .map(k => `${k},${fieldVal[k]}`)
          .join(',')
      );
    }
  } else {
    return fieldName + '=' + fieldVal.toString();
  }
}

function delimitedEncodeField(fieldVal: any, fieldName: string, delimeter: string): string {
  if (Array.isArray(fieldVal)) {
    return fieldVal.map(v => v.toString()).join(delimeter);
  } else if (typeof fieldVal === 'object') {
    return Object.keys(fieldVal)
      .map(k => `${k}${delimeter}${fieldVal[k]}`)
      .join(delimeter);
  } else {
    return fieldName + '=' + fieldVal.toString();
  }
}

function deepObjectEncodeField(fieldVal: any, fieldName: string): string {
  if (Array.isArray(fieldVal)) {
    console.warn('deepObject style cannot be used with array value:' + fieldVal.toString());
    return '';
  } else if (typeof fieldVal === 'object') {
    return Object.keys(fieldVal)
      .map(k => `${fieldName}[${k}]=${fieldVal[k]}`)
      .join('&');
  } else {
    console.warn('deepObject style cannot be used with non-object value:' + fieldVal.toString());
    return '';
  }
}

/*
 * Should be used only for url-form-encoded body payloads
 * To be used for parmaters should be extended with other style values
 */
export function urlFormEncodePayload(
  payload: object,
  encoding: { [field: string]: OpenAPIEncoding } = {},
) {
  if (Array.isArray(payload)) {
    throw new Error('Payload must have fields: ' + payload.toString());
  } else {
    return Object.keys(payload)
      .map(fieldName => {
        const fieldVal = payload[fieldName];
        const { style = 'form', explode = true } = encoding[fieldName] || {};
        switch (style) {
          case 'form':
            return formEncodeField(fieldVal, fieldName, explode);
            break;
          case 'spaceDelimited':
            return delimitedEncodeField(fieldVal, fieldName, '%20');
          case 'pipeDelimited':
            return delimitedEncodeField(fieldVal, fieldName, '|');
          case 'deepObject':
            return deepObjectEncodeField(fieldVal, fieldName);
          default:
            // TODO implement rest of styles for path parameters
            console.warn('Incorrect or unsupported encoding style: ' + style);
            return '';
        }
      })
      .join('&');
  }
}

export function langFromMime(contentType: string): string {
  if (contentType.search(/xml/i) !== -1) {
    return 'xml';
  }
  return 'clike';
}

export function isNamedDefinition(pointer?: string): boolean {
  return /^#\/components\/schemas\/[^\/]+$/.test(pointer || '');
}

function humanizeRangeConstraint(
  description: string,
  min: number | undefined,
  max: number | undefined,
): string | undefined {
  let stringRange;
  if (min !== undefined && max !== undefined) {
    if (min === max) {
      stringRange = `${min} ${description}`;
    } else {
      stringRange = `[ ${min} .. ${max} ] ${description}`;
    }
  } else if (max !== undefined) {
    stringRange = `<= ${max} ${description}`;
  } else if (min !== undefined) {
    if (min === 1) {
      stringRange = 'non-empty';
    } else {
      stringRange = `>= ${min} ${description}`;
    }
  }

  return stringRange;
}

export function humanizeConstraints(schema: OpenAPISchema): string[] {
  const res: string[] = [];

  const stringRange = humanizeRangeConstraint('characters', schema.minLength, schema.maxLength);
  if (stringRange !== undefined) {
    res.push(stringRange);
  }

  const arrayRange = humanizeRangeConstraint('items', schema.minItems, schema.maxItems);
  if (arrayRange !== undefined) {
    res.push(arrayRange);
  }

  let numberRange;
  if (schema.minimum !== undefined && schema.maximum !== undefined) {
    numberRange = schema.exclusiveMinimum ? '( ' : '[ ';
    numberRange += schema.minimum;
    numberRange += ' .. ';
    numberRange += schema.maximum;
    numberRange += schema.exclusiveMaximum ? ' )' : ' ]';
  } else if (schema.maximum !== undefined) {
    numberRange = schema.exclusiveMaximum ? '< ' : '<= ';
    numberRange += schema.maximum;
  } else if (schema.minimum !== undefined) {
    numberRange = schema.exclusiveMinimum ? '> ' : '>= ';
    numberRange += schema.minimum;
  }

  if (numberRange !== undefined) {
    res.push(numberRange);
  }

  return res;
}

export function sortByRequired(
  fields: Array<{ required: boolean; name: string }>,
  order: string[] = [],
) {
  fields.sort((a, b) => {
    if (!a.required && b.required) {
      return 1;
    } else if (a.required && !b.required) {
      return -1;
    } else if (a.required && b.required) {
      return order.indexOf(a.name) - order.indexOf(b.name);
    } else {
      return 0;
    }
  });
}

export function sortByField<T extends string>(fields: Array<{ [P in T]: string }>, param: T) {
  fields.sort((a, b) => {
    return a[param].localeCompare(b[param]);
  });
}

export function mergeParams(
  parser: OpenAPIParser,
  pathParams: Array<Referenced<OpenAPIParameter>> = [],
  operationParams: Array<Referenced<OpenAPIParameter>> = [],
): Array<Referenced<OpenAPIParameter>> {
  const operationParamNames = {};
  operationParams.forEach(param => {
    param = parser.shalowDeref(param);
    operationParamNames[param.name + '_' + param.in] = true;
  });

  // filter out path params overriden by operation ones with the same name
  pathParams = pathParams.filter(param => {
    param = parser.shalowDeref(param);
    return !operationParamNames[param.name + '_' + param.in];
  });

  return pathParams.concat(operationParams);
}

export function mergeSimilarMediaTypes(types: Dict<OpenAPIMediaType>): Dict<OpenAPIMediaType> {
  const mergedTypes = {};
  Object.keys(types).forEach(name => {
    const mime = types[name];
    // ignore content type parameters (e.g. charset) and merge
    const normalizedMimeName = name.split(';')[0].trim();
    if (!mergedTypes[normalizedMimeName]) {
      mergedTypes[normalizedMimeName] = mime;
      return;
    }
    mergedTypes[normalizedMimeName] = { ...mergedTypes[normalizedMimeName], ...mime };
  });

  return mergedTypes;
}

function expandVariables(url: string, variables: object = {}) {
  return url.replace(
    /(?:{)(\w+)(?:})/g,
    (match, name) => (variables[name] && variables[name].default) || match,
  );
}

export function normalizeServers(
  specUrl: string | undefined,
  servers: OpenAPIServer[],
): OpenAPIServer[] {
  const baseUrl =
    specUrl === undefined ? (IS_BROWSER ? window.location.href : '') : dirname(specUrl);

  if (servers.length === 0) {
    return [
      {
        url: baseUrl,
      },
    ];
  }

  function normalizeUrl(url: string, variables: object | undefined): string {
    url = expandVariables(url, variables);
    return resolveUrl(baseUrl, url);
  }

  return servers.map(server => {
    return {
      ...server,
      url: normalizeUrl(server.url, server.variables),
      description: server.description || '',
    };
  });
}

export const SECURITY_DEFINITIONS_COMPONENT_NAME = 'security-definitions';
export let SECURITY_SCHEMES_SECTION_PREFIX = 'section/Authentication/';
export function setSecuritySchemePrefix(prefix: string) {
  SECURITY_SCHEMES_SECTION_PREFIX = prefix;
}

export const shortenHTTPVerb = verb =>
  ({
    delete: 'del',
    options: 'opts',
  }[verb] || verb);

export function isRedocExtension(key: string): boolean {
  const redocExtensions = {
    'x-circular-ref': true,
    'x-code-samples': true,
    'x-displayName': true,
    'x-examples': true,
    'x-ignoredHeaderParameters': true,
    'x-logo': true,
    'x-nullable': true,
    'x-servers': true,
    'x-tagGroups': true,
    'x-traitTag': true,
  };

  return key in redocExtensions;
}

export function extractExtensions(obj: object, showExtensions: string[] | true): Dict<any> {
  return Object.keys(obj)
    .filter(key => {
      if (showExtensions === true) {
        return key.startsWith('x-') && !isRedocExtension(key);
      }
      return key.startsWith('x-') && showExtensions.indexOf(key) > -1;
    })
    .reduce((acc, key) => {
      acc[key] = obj[key];
      return acc;
    }, {});
}

export function pluralizeType(displayType: string): string {
  return displayType
    .split(' or ')
    .map(type => type.replace(/^(string|object|number|integer|array|boolean)( ?.*)/, '$1s$2'))
    .join(' or ');
}
