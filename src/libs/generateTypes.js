const { attributeFields } = require('graphql-sequelize');
const {
  GraphQLObjectType,
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLEnumType,
  GraphQLNonNull
} = require('graphql');
const {
  defaultListArgs,
  defaultArgs
} = require('graphql-sequelize');

const { isFieldArray, isFieldRequired, sanitizeField } = require('../utils');
const constants = require('../constants');

const stringToTypeMap = constants.STRINGTOTYPEMAP;
const JOINS = constants.JOINS.get();
const OPS = constants.OPS.get();

const queryResolver = require('../resolvers/query');

const options = {};

/**
 * Returns a new `GraphQLType` generated from a custom type.
 *
 * {fieldName: TYPE}
 * {fieldName: TYPE, allowNull: BOOLEAN} allowNull defaults to false
 *
 * TYPE examples
 * 'int'
 * 'string'
 * 'boolean'
 * 'float'
 * 'id'
 * 'date'
 * 'json'
 * 'SEQUELIZE_MODEL_NAME'
 * 'CUSTOM_TYPE_NAME'
 * 'int!' Non Null
 * '[int]' List
 * '[int]!' Non Null List
 * '[int!]' List of Non Null items
 * Sequelize.Model
 *
 **/
function generateGraphQLField(fieldType, existingTypes = {}) {

  // ENUM when array
  if (Array.isArray(fieldType)) {

    const values = {};

    fieldType.forEach((value) => {
      if (Array.isArray(value)) {
        values[value[0]] = { value: value[1] };
      } else {
        values[value] = { value };
      }
    });

    return values;
  }

  const sanitizedField = sanitizeField(fieldType);

  let field = existingTypes[sanitizedField] || stringToTypeMap[sanitizedField.toLowerCase()] || stringToTypeMap['string'];
  const isArray = isFieldArray(fieldType);
  const isRequired = isFieldRequired(fieldType);

  if (isArray) {

    if (isArray === 1) {
      field = new GraphQLList(field);
    } else if (isArray === 2) {
      field = GraphQLNonNull(new GraphQLList(field));
    } else if (isArray === 3) {
      field = new GraphQLList(GraphQLNonNull(field));
    }

  } else if (isRequired) {
    field = GraphQLNonNull(field);
  }

  return field;
}

const joinTypeEnum = new GraphQLEnumType({
  name: 'SequelizeJoinEnum',
  description: 'Join between parent and child type.',
  values: generateGraphQLField(JOINS)
});

const opsTypeEnum = new GraphQLEnumType({
  name: 'OpsEnum',
  description: 'Operation on object. Defaults to KEEP.',
  values: generateGraphQLField(OPS)
});

function generateIncludeArguments(includeArguments, existingTypes = {}, isInput = false) {
  const fields = {};

  for (const argument in includeArguments) {
    if (includeArguments[argument].output && includeArguments[argument].resolver) {
      if (!isInput) {
        fields[argument] = { type: generateGraphQLField(includeArguments[argument].output, existingTypes), resolve: includeArguments[argument].resolver };
      }
    } else {
      fields[argument] = { type: generateGraphQLField(includeArguments[argument], existingTypes) };
    }

  }

  return fields;
}

/**
* Returns the association fields of an entity.
*
* It iterates over all the associations and produces an object compatible with GraphQL-js.
* BelongsToMany and HasMany associations are represented as a `GraphQLList` whereas a BelongTo
* is simply an instance of a type.
* @param {*} associations A collection of sequelize associations
* @param {*} existingTypes Existing `GraphQLObjectType` types, created from all the Sequelize models
*/
function generateAssociationFields(associations, existingTypes = {}, isInput = false) {

  const fields = {};
  const { nestedMutations } = options;

  for (const associationName in associations) {

    const relation = associations[associationName];
    const target = relation.target;

    if (!existingTypes[target.name]) {
      return fields;
    }

    // BelongsToMany is represented as a list, just like HasMany
    const type = relation.associationType === 'BelongsToMany' ||
      relation.associationType === 'HasMany'
      ? new GraphQLList(existingTypes[target.name])
      : existingTypes[target.name];

    // Remove belongs to associations for input types to avoide foreign key constraint errors.
    if (!(isInput && relation.associationType === 'BelongsTo') && !(isInput && !nestedMutations)) {
      fields[associationName] = { type };
    }

    // Add through table, this doesn't need resolver since this is already included when quering n:m relations.
    if (relation.associationType === 'BelongsToMany') {
      fields[relation.through.model.name] = {
        type: existingTypes[relation.through.model.name]
      };
    }

    // Add operation field for nested mutations
    if (isInput) {
      fields._Op = { type: opsTypeEnum, description: 'Used when mutating relations in update mutations.' };
    }

    // GraphQLInputObjectType do not accept fields with resolve
    if (!isInput && !relation.isRemote) {

      // when using dataloader belongsToMany would become an array with plural key name. In that case we need to filter out records manually.
      if (relation.associationType === 'BelongsToMany' && options.dataloader) {
        fields[relation.through.model.name].resolve = (source, args, ctx) => {
          const parentName = source.constructor.name;
          const grandParentName = ctx.GrandParent.constructor.name;
          const parentAssociations = relation.source.associations;
          const grandParentAssociations = relation.target.associations;
          const keysToMatch = {};

          // foreignkey is inversed hence source and grandparent are also inversed
          for (const key in parentAssociations) {
            const association = parentAssociations[key];

            if (association.target.name === grandParentName) {
              keysToMatch[association.foreignKey] = source[association.targetKey];
              break;
            }
          }

          for (const key in grandParentAssociations) {
            const association = grandParentAssociations[key];

            if (association.target.name === parentName) {
              keysToMatch[association.foreignKey] = ctx.GrandParent[association.targetKey];
              break;
            }
          }

          const includeMap = source._options.includeMap;

          for (const key in includeMap) {

            if (includeMap[key].model.name === relation.through.model.name) {
              const data = source[key];

              for (let index = 0; index < data.length; index++) {

                const item = data[index].toJSON();

                const found = Object.keys(keysToMatch).reduce((result, foreignKey) => {
                  const value = keysToMatch[foreignKey];

                  result = item[foreignKey] == value;

                  return result;

                }, false);

                if (found) return data[index];

              }

            }
          }
        };
      }

      const throughArguments = relation.associationType === 'BelongsToMany' ? { throughWhere: defaultListArgs().where } : {};
      const joinType = relation.source.graphql.joins ? { join: { type: joinTypeEnum } } : {};

      fields[associationName].args = Object.assign(defaultArgs(relation), defaultListArgs(), throughArguments, joinType);
      fields[associationName].resolve = (source, args, context, info) => {

        // to be able to fetch this in through tables
        context.GrandParent = source;

        // when using joins, association data is coming as an included model
        if (JOINS.includes(args.join)) {
          return source[associationName];
        }

        return queryResolver(options)(relation, source, args, context, info, true);
      };

    }

  }

  return fields;
}

/**
* Returns a new `GraphQLObjectType` created from a sequelize model.
*
* It creates a `GraphQLObjectType` object with a name and fields. The
* fields are generated from its sequelize associations.
* @param {*} model The sequelize model used to create the `GraphQLObjectType`
* @param {*} types Existing `GraphQLObjectType` types, created from all the Sequelize models
*/
function generateGraphQLTypeFromModel(model, existingTypes = {}, isInput = false, cache) {
  const GraphQLClass = isInput ? GraphQLInputObjectType : GraphQLObjectType;
  const attributes = model.graphql.attributes || {};
  const modelAttributes = model.rawAttributes;

  const renameFieldMap = Object.keys(modelAttributes).reduce((attributes, attributeName) => {

    const attribute = modelAttributes[attributeName];

    if (attribute.rename) attributes[attribute.fieldName] = attribute.rename;

    return attributes;
  }, {});

  const modelAttributeFields = attributeFields(model, Object.assign({}, { allowNull: Boolean(isInput), cache, commentToDescription: true, map: renameFieldMap, exclude: attributes.exclude }));

  return new GraphQLClass({
    name: isInput ? `${model.name}Input` : model.name,
    fields: () => Object.assign(
      {},
      modelAttributeFields,
      generateAssociationFields(model.associations, existingTypes, isInput),
      // Include attributes which are to be included in GraphQL Type but doesn't exist in Models.
      (attributes.include ? generateIncludeArguments(attributes.include, existingTypes, isInput) : {})
    )
  });
}

function generateGraphQLTypeFromJson(typeJson, existingTypes = {}, allCustomTypes = {}, isInput = false, cache) {

  const GraphQLClass = isInput ? GraphQLInputObjectType : GraphQLObjectType;
  const name = typeJson.name;
  const type = typeJson.type;

  const typeName = isInput ? name.toLowerCase().endsWith('input') ? name : `${name}Input` : name;

  // If Array generate ENUM type and return.
  if (Array.isArray(typeJson.type)) {
    return new GraphQLEnumType({
      name: typeName,
      values: generateGraphQLField(type)
    });
  }

  const fields = {};

  for (const fieldName in type) {

    const sanitizedTypeName = sanitizeField(type[fieldName]);

    // Recursively generate nested types
    if (allCustomTypes[sanitizedTypeName] && !existingTypes[sanitizedTypeName]) {
      existingTypes[sanitizedTypeName] = generateGraphQLTypeFromJson({ name: sanitizedTypeName, type: allCustomTypes[sanitizedTypeName] }, existingTypes, allCustomTypes, isInput, cache);
    }

    fields[fieldName] = { type: generateGraphQLField(type[fieldName], existingTypes) };

  }

  return new GraphQLClass({
    name: typeName,
    fields: () => fields
  });

}

/**
* Returns a collection of `GraphQLObjectType` generated from Sequelize models.
*
* It creates an object whose properties are `GraphQLObjectType` created
* from Sequelize models.
* @param {*} models The sequelize models used to create the types
*/
function generateModelTypes(models, remoteTypes = {}, options) {

  const customTypes = options.types;
  const importTypes = options.importTypes;
  const outputTypes = remoteTypes || {};
  const inputTypes = {};
  const inputCustomTypes = [];
  const allCustomTypes = {};

  Object.keys(models).forEach((modelName) => {

    const model = models[modelName];
    const cache = {};

    model.graphql = model.graphql || {};
    outputTypes[modelName] = generateGraphQLTypeFromModel(model, outputTypes, false, cache);
    inputTypes[modelName] = generateGraphQLTypeFromModel(model, inputTypes, true, cache);

    // accumulate all types from all models
    Object.assign(allCustomTypes, customTypes, model.graphql.types, customTypes, importTypes);

    const allOperations = Object.assign({}, model.graphql.queries, model.graphql.mutations, options.queries, options.mutations);

    for (const operation in allOperations) {
      if (allOperations[operation].input) inputCustomTypes.push(sanitizeField(allOperations[operation].input));
    }

  });

  for (const typeName in allCustomTypes) {
    const cache = {};
    const type = {
      name: typeName,
      type: allCustomTypes[typeName]
    };

    if (inputCustomTypes.includes(typeName) && !inputTypes[typeName]) {
      inputTypes[typeName] = importTypes[typeName] || generateGraphQLTypeFromJson(type, inputTypes, allCustomTypes, true, cache);
    }

    if (!outputTypes[typeName]) {
      outputTypes[typeName] = importTypes[typeName] || generateGraphQLTypeFromJson(type, outputTypes, allCustomTypes, false, cache);
    }

  }

  return { outputTypes, inputTypes };
}

module.exports = (_options) => {

  Object.assign(options, _options);

  return {
    generateModelTypes,
    generateGraphQLField,
    generateGraphQLTypeFromJson,
    generateGraphQLTypeFromModel,
    generateAssociationFields,
    generateIncludeArguments
  };
};