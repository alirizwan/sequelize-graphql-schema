/* eslint-disable no-undef */
const {
  GraphQLInt,
  GraphQLBoolean,
  GraphQLFloat,
  GraphQLString,
  GraphQLID,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLInputObjectType
} = require('graphql');
const { JSONType, DateType } = require('graphql-sequelize');
const stringifier = require('stringifier')({ maxDepth: 10, indent: '  ' });
const { generateGraphQLField, generateGraphQLTypeFromJson, generateGraphQLTypeFromModel, generateModelTypes } = require('../generateTypes')({});
const Sequelize = require('sequelize');
const sequelize = new Sequelize({ dialect: 'sqlite' });

describe('Type Generators', () => {

  it('[generateGraphQLField] Should generate graphQL Field Types.', () => {
    expect(generateGraphQLField('string')).toEqual(GraphQLString);
    expect(generateGraphQLField('String')).toEqual(GraphQLString);
    expect(generateGraphQLField('int')).toEqual(GraphQLInt);
    expect(generateGraphQLField('INT')).toEqual(GraphQLInt);
    expect(generateGraphQLField('boolean')).toEqual(GraphQLBoolean);
    expect(generateGraphQLField('float')).toEqual(GraphQLFloat);
    expect(generateGraphQLField('id')).toEqual(GraphQLID);
    expect(generateGraphQLField('json')).toEqual(JSONType);
    expect(generateGraphQLField('date')).toEqual(DateType);
    expect(generateGraphQLField('[string]')).toEqual(new GraphQLList(GraphQLString));
    expect(generateGraphQLField('string!')).toEqual(GraphQLNonNull(GraphQLString));
    expect(generateGraphQLField('[string]!')).toEqual(GraphQLNonNull(new GraphQLList(GraphQLString)));
    expect(generateGraphQLField('[string!]')).toEqual(new GraphQLList(GraphQLNonNull(GraphQLString)));
  });

  describe('[generateGraphQLTypeFromJson, generateGraphQLTypeFromModel] Should generate types from models and custom types.', () => {

    const modelA = sequelize.define('modelA', {
      fieldA: Sequelize.STRING,
      fieldB: Sequelize.INTEGER
    });

    modelA.graphql = { attributes: {} };

    const modelAType = new GraphQLObjectType({
      name: 'modelA',
      fields: () => ({
        fieldA: {
          type: GraphQLString
        },
        fieldB: {
          type: GraphQLInt
        }
      })
    });

    const typeAInput = new GraphQLInputObjectType({
      name: 'typeAInput',
      fields: () => ({
        fieldA: {
          type: GraphQLFloat
        },
        fieldB: {
          type: JSONType
        }
      })
    });

    const typeB = new GraphQLObjectType({
      name: 'typeB',
      fields: () => ({
        fieldA: {
          type: GraphQLString
        },
        fieldB: {
          type: GraphQLInt
        }
      })
    });

    const typeC = new GraphQLObjectType({
      name: 'typeC',
      fields: () => ({
        fieldA: {
          type: typeB
        },
        fieldB: {
          type: modelAType
        }
      })
    });

    const typeD = new GraphQLObjectType({
      name: 'typeD',
      fields: () => ({
        fieldA: {
          type: typeC
        }
      })
    });

    const types = {
      modelA: generateGraphQLTypeFromModel(modelA),
      typeAInput: generateGraphQLTypeFromJson({
        name: 'typeAInput',
        type: { fieldA: 'float', fieldB: 'json' }
      }, {}, {}, true),
      typeB: generateGraphQLTypeFromJson({
        name: 'typeB',
        type: { fieldA: 'string', fieldB: 'int' }
      }),
      typeC: generateGraphQLTypeFromJson({
        name: 'typeC',
        type: { fieldA: 'typeB', fieldB: 'modelA' }
      }, { typeB: this.typeB, modelA: 'modelA' }),
      typeD: generateGraphQLTypeFromJson({
        name: 'typeD',
        type: { fieldA: 'typeC' }
      }, { typeB: this.typeB, typeC: this.typeC })
    };

    it('Should create type from a Model.', () => {
      expect(stringifier(types.modelA)).toEqual(stringifier(modelAType));
    });

    it('Should create input type for a Custom Type.', () => {
      expect(stringifier(types.typeAInput)).toEqual(stringifier(typeAInput));
    });

    it('Should create output type for a Custom Type.', () => {
      expect(stringifier(types.typeB)).toEqual(stringifier(typeB));
    });

    it('Should create output type for a 1-level Nested Custom Type.', () => {
      expect(stringifier(types.typeC)).toEqual(stringifier(typeC));
    });

    it('Should create output type for a Multi-level Nested Custom Type.', () => {
      expect(stringifier(types.typeD)).toEqual(stringifier(typeD));
    });

  });

  describe('[generateAssociationFields, generateGraphQLTypeFromModel] Should generate types with associations from Models.', () => {

    const modelB = sequelize.define('modelB', {
      fieldA: Sequelize.STRING,
      fieldB: Sequelize.INTEGER
    });

    const modelC = sequelize.define('modelC', {
      fieldA: Sequelize.STRING,
      fieldB: Sequelize.INTEGER
    });

    const modelD = sequelize.define('modelD', {
      fieldA: Sequelize.STRING,
      fieldB: Sequelize.INTEGER
    });

    const modelE = sequelize.define('modelE', {});

    modelB.hasMany(modelC);
    modelC.belongsTo(modelB);
    modelD.belongsToMany(modelB, { through: modelE });
    modelB.belongsToMany(modelD, { through: modelE });

    let modelBType = {};

    const modelCType = new GraphQLObjectType({
      name: 'modelC',
      fields: () => ({
        fieldA: {
          type: GraphQLString
        },
        fieldB: {
          type: GraphQLInt
        },
        modelB: modelBType
      })
    });

    modelBType = new GraphQLObjectType({
      name: 'modelB',
      fields: () => ({
        fieldA: {
          type: GraphQLString
        },
        fieldB: {
          type: GraphQLInt
        },
        modelC: new GraphQLList(modelCType)
      })
    });

    const { outputTypes } = generateModelTypes({ modelB, modelC, modelD, modelE });

    it('Should create hasMany association from Model B > C.', () => {
      expect(outputTypes.modelB._fields().modelC).toEqual(modelBType._fields().modelC);
    });

    it('Should create belongsTo association from Model C > B.', () => {
      expect(stringifier(outputTypes.modelC._fields().modelB)).toEqual(stringifier(modelB));
    });

  });

});