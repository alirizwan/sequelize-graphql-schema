/* eslint-disable no-undef */
const { generateName, sanitizeField, isFieldRequired, isFieldArray } = require('../utils');

describe('Utility functions', () => {

  it('should generate names from template', () => {

    expect(generateName('{name}Get', { name: 'Product' })).toEqual('productGet');
    expect(generateName('{name}', { name: 'Product' })).toEqual('product');
    expect(generateName('{name}name', { name: 'Product' })).toEqual('productName');
    expect(generateName('customName', { name: 'Product' })).toEqual('customName');
    expect(generateName('{name}{type}', { name: 'Product', type: 'Create' })).toEqual('productCreate');
    expect(generateName('{name}{type}{bulk}', { name: 'Product', type: 'Create' })).toEqual('productCreate');
    expect(generateName('{bulk}{name}{type}', { name: 'Product', type: 'Create', bulk: 'Bulk' })).toEqual('bulkProductCreate');
    expect(generateName('{bulk}{name}{type}', { name: 'product', type: 'Create', bulk: 'bulk' }, { pascalCase: true })).toEqual('BulkProductCreate');
    expect(generateName('My{bulk}Custom{name}dope{type}', { name: 'product', type: 'Create', bulk: 'bulk' }, { pascalCase: true })).toEqual('MyBulkCustomProductDopeCreate');

    expect(() => generateName('')).toThrow();
    expect(() => generateName(null)).toThrow();
    expect(() => generateName(undefined)).toThrow();

  });

  it('should sanitize field names', () => {

    expect(sanitizeField('[name')).toEqual('name');
    expect(sanitizeField('[name]')).toEqual('name');
    expect(sanitizeField('[name]!')).toEqual('name');
    expect(sanitizeField('[name!]')).toEqual('name');
    expect(sanitizeField('![name]')).toEqual('name');
    expect(sanitizeField('name!')).toEqual('name');
    expect(sanitizeField('name!]')).toEqual('name');

    expect(() => sanitizeField('')).toThrow();
    expect(() => sanitizeField(null)).toThrow();
    expect(() => sanitizeField(undefined)).toThrow();
    expect(() => sanitizeField('!')).toThrow();

  });

  it('should check if field is required', () => {

    expect(isFieldRequired('name!')).toEqual(true);
    expect(isFieldRequired('!name')).toEqual(true);
    expect(isFieldRequired('name')).toEqual(false);

  });

  it('should check if field is an array', () => {

    expect(isFieldArray('[name]!')).toEqual(2);
    expect(isFieldArray('[name]')).toEqual(1);
    expect(isFieldArray('[name!]')).toEqual(3);
    expect(isFieldArray('[!name]')).toEqual(1);

    expect(isFieldArray('![name]')).toEqual(0);
    expect(isFieldArray('[name')).toEqual(0);
    expect(isFieldArray('name')).toEqual(0);
    expect(isFieldArray('name]')).toEqual(0);

  });

});