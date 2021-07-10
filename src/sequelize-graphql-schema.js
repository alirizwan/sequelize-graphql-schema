/* eslint-disable max-depth */
require('./jsdoc.def');
const {
  GraphQLObjectType,
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLInt,
  GraphQLNonNull,
  GraphQLString,
  GraphQLBoolean,
  GraphQLEnumType
} = require('graphql');
const {
  resolver,
  defaultListArgs,
  defaultArgs,
  argsToFindOptions,
  relay
} = require('graphql-sequelize');
const { PubSub, withFilter } = require('graphql-subscriptions');
const pubsub = new PubSub();
const Sequelize = require('sequelize');
const attributeFields = require('./graphql-sequelize/attributeFields');
const { sequelizeConnection } = relay;
const camelCase = require('camelcase');
const remoteSchema = require('./remoteSchema');
const { GraphQLClient } = require('graphql-request');
const _ = require('lodash');
const { createContext, EXPECTED_OPTIONS_KEY, resetCache } = require('dataloader-sequelize');
const TRANSACTION_NAMESPACE = 'sequelize-graphql-schema';
const cls = require('cls-hooked');
const { v4: uuid } = require('uuid');
const sequelizeNamespace = cls.createNamespace(TRANSACTION_NAMESPACE);
let dataloaderContext;

let options = {
  exclude: [],
  includeArguments: {},
  remote: {},
  dataloader: false,
  customTypes: [],
  transactionedMutations: true,
  privateMode: false,
  logger() {
    return Promise.resolve();
  },
  authorizer() {
    return Promise.resolve();
  },
  errorHandler: {
    'ETIMEDOUT': {
      statusCode: 503
    }
  }
};

/** @type {SeqGraphQL} */
const defaultModelGraphqlOptions = {
  attributes: {
    exclude: { // list attributes which are to be ignored in Model Input (exclusive filter)
      create: [],
      update: [],
      fetch: []
    },
    only: { // allow to use only listed attributes (inclusive filter, it ignores exclude option)
      create: null,
      update: null,
      fetch: null
    },
    include: {}, // attributes in key:type format which are to be included in Model Input
    import: []
  },
  scopes: null,
  alias: {},
  bulk: [],
  mutations: {},
  subscriptions: {},
  queries: {},
  excludeMutations: [],
  excludeSubscriptions: [],
  excludeQueries: [],
  extend: {},
  before: {},
  subsFilter: {},
  overwrite: {}
};

let Models = {};

const errorHandler = (error) => {
  for (const name in options.errorHandler) {
    if (error.message.indexOf(name) > -1) {
      Object.assign(error, options.errorHandler[name]);
      break;
    }
  }

  return error;
};

const whereQueryVarsToValues = (o, vals) => {
  [
    ...Object.getOwnPropertyNames(o),
    ...Object.getOwnPropertySymbols(o)
  ].forEach((k) => {
    if (_.isFunction(o[k])) {
      o[k] = o[k](vals);

      return;
    }
    if (_.isObject(o[k])) {
      whereQueryVarsToValues(o[k], vals);
    }
  });
};

const getTypeByString = (type) => {
  const lType = type.toLowerCase();

  return lType === 'int' ? GraphQLInt
    : lType === 'boolean' ? GraphQLBoolean
      : lType === 'string' ? GraphQLString
        : options.customTypes[type] ? options.customTypes[type]
          : null;
};

/**
 * @typedef Name
 * @property {string} singular
 * @property {string} plural
 */

/**
 * @param {Name} name
 * @returns string
 */
const assocSuffix = (model, plural = false, asName = null) => {
  return _.upperFirst(asName ? asName : (plural && !model.options.freezeTableName ? model.options.name.plural : model.options.name.singular));
};

const remoteResolver = async (source, args, context, info, remoteQuery, remoteArguments, type) => {

  const availableArgs = _.keys(remoteQuery.args);
  const pickedArgs = _.pick(remoteArguments, availableArgs);
  const queryArgs = [];
  const passedArgs = [];

  for (const arg in pickedArgs) {
    queryArgs.push(`$${arg}:${pickedArgs[arg].type}`);
    passedArgs.push(`${arg}:$${arg}`);
  }

  const fields = _.keys(type.getFields());

  const query = `query ${remoteQuery.name}(${queryArgs.join(', ')}){
    ${remoteQuery.name}(${passedArgs.join(', ')}){
      ${fields.join(', ')}
    }
  }`;

  const variables = _.pick(args, availableArgs);
  const key = remoteQuery.to || 'id';

  if (_.indexOf(availableArgs, key) > -1 && !variables.where) {
    variables[key] = source[remoteQuery.with];
  } else if (_.indexOf(availableArgs, 'where') > -1) {
    variables.where = variables.where || {};
    variables.where[key] = source[remoteQuery.with];
  }

  const headers = _.pick(context.headers, remoteQuery.headers);
  const client = new GraphQLClient(remoteQuery.endpoint, {
    headers
  });
  const data = await client.request(query, variables);

  return data[remoteQuery.name];

};

const getTypeName = (model, isInput, isUpdate, isAssoc) => {
  return isInput ? model.name + (isUpdate ? 'Edit' : 'Add') + 'Input' + (isAssoc ? 'Connection' : '') : model.name;
};

const includeArguments = () => {
  const includeArguments = {};

  for (const argument in options.includeArguments) {
    includeArguments[argument] = generateGraphQLField(options.includeArguments[argument]);
  }

  return includeArguments;
};

const defaultMutationArgs = () => {
  return {
    set: {
      type: GraphQLBoolean,
      description: 'If true, all relations use \'set\' operation instead of \'add\', destroying existing'
    },
    transaction: {
      type: GraphQLBoolean,
      description: 'Enable transaction for this operation and all its nested'
    },
  };
};

const execBefore = (model, source, args, context, info, type, where) => {
  if (model.graphql && _.has(model.graphql, 'before') && _.has(model.graphql.before, type)) {
    return model.graphql.before[type](source, args, context, info, where);
  }

  return Promise.resolve();
};

const findOneRecord = (model, where) => {
  if (where) {
    return model.findOne({ where });
  }

  return Promise.resolve();

};

const queryResolver = (model, isAssoc = false, field = null, assocModel = null) => {
  return async (source, args, context, info) => {
    if (args.where) whereQueryVarsToValues(args.where, info.variableValues);

    const _model = !field && isAssoc && model.target ? model.target : model;
    const type = 'fetch';

    // authorization should not be executed for nested queries
    if (!isAssoc) await options.authorizer(source, args, context, info);

    if (_.has(_model.graphql.overwrite, type)) {
      return _model.graphql.overwrite[type](source, args, context, info);
    }

    await execBefore(_model, source, args, context, info, type);

    const before = (findOptions, args, context, info) => {

      const orderArgs = args.order || '';
      const orderBy = [];

      if (orderArgs != '') {
        const orderByClauses = orderArgs.split(',');

        orderByClauses.forEach((clause) => {
          if (clause.indexOf('reverse:') === 0) {
            orderBy.push([clause.substring(8), 'DESC']);
          } else {
            orderBy.push([clause, 'ASC']);
          }
        });
      }

      if (args.orderEdges) {
        const orderByClauses = args.orderEdges.split(',');

        orderByClauses.forEach((clause) => {
          const colName = '`' + model.through.model.name + '`.`' + (clause.indexOf('reverse:') === 0 ? clause.substring(8) : clause) + '`';

          orderBy.push([Sequelize.col(colName), clause.indexOf('reverse:') === 0 ? 'DESC' : 'ASC']);
        });
      }

      findOptions.order = orderBy;

      if (args.whereEdges) {
        if (!findOptions.where)
          findOptions.where = {};

        for (const key in args.whereEdges) {
          if (_.has(args.whereEdges, key)) {
            whereQueryVarsToValues(args.whereEdges, info.variableValues);

            const colName = '`' + model.through.model.name + '`.`' + key + '`';

            findOptions.where[colName] = Sequelize.where(Sequelize.col(colName), args.whereEdges[key]);
          }
        }
      }

      findOptions.paranoid = ((args.where && args.where.deletedAt && args.where.deletedAt.ne === null) || args.paranoid === false) ? false : _model.options.paranoid;

      return findOptions;
    };

    const scope = Array.isArray(_model.graphql.scopes) ? {
      method: [_model.graphql.scopes[0], _.get(args, _model.graphql.scopes[1], _model.graphql.scopes[2] || null)]
    } : _model.graphql.scopes;

    let data;

    if (field) {
      const modelNode = source.node[_model.name];

      data = modelNode[field];
    } else {
      data = await resolver(model instanceof Sequelize.Model ? model.scope(scope) : model, {
        [EXPECTED_OPTIONS_KEY]: dataloaderContext,
        before,
        separate: isAssoc
      })(source, args, context, info);
    }

    // little trick to pass args
    // on source params for connection fields
    if (data) {
      data.__args = args;
      data.__parent = source;
    }

    if (_.has(_model.graphql.extend, type)) {
      return _model.graphql.extend[type](data, source, args, context, info);
    }

    return data;

  };
};

const mutationResolver = async (model, inputTypeName, mutationName, source, args, context, info, type, where, isBulk) => {

  if (args.where) whereQueryVarsToValues(args.where, info.variableValues);
  if (where) whereQueryVarsToValues(where, info.variableValues);

  await options.authorizer(source, args, context, info);

  const preData = await findOneRecord(model, type === 'destroy' || type === 'update' ? where : null);
  const operationType = (isBulk && type === 'create') ? 'bulkCreate' : type;
  const validate = true;

  if (typeof isBulk === 'string' && args[inputTypeName].length && !args[inputTypeName][0][isBulk]) {

    const bulkAddId = uuid();

    args[inputTypeName].forEach((input) => {
      input[isBulk] = bulkAddId;
    });

  }

  let data = {};

  const operation = async function (opType, _model, _source, _args, name, assocInst, sourceInst, transaction, toDestroy = null) {
    const hookType = opType == 'set' ? 'update' : type;

    if (_model.graphql && _.has(_model.graphql.overwrite, hookType)) {
      return _model.graphql.overwrite[hookType](_source, _args, context, info, where);
    }

    await execBefore(_model, _source, _args, context, info, hookType, where);

    const finalize = async (res) => {
      let _data = {};

      if ((opType === 'create' || opType === 'update' || opType === 'upsert') && !isBulk) {
        _data = await createAssoc(_model, res, _args[name], transaction);
      }

      if (_.has(_model.graphql.extend, hookType)) {
        return _model.graphql.extend[hookType](type === 'destroy' ? preData : res, _source, _args, context, info, where);
      }

      res = Object.assign(res, _data);

      const subsData = type === 'destroy' ? preData : res;

      let mutationType;

      switch (type) {
        case 'create':
          mutationType = isBulk ? 'BULK_CREATED' : 'CREATED';
          break;
        case 'destroy':
          mutationType = 'DELETED';
          break;
        case 'update':
        case 'upsert':
          mutationType = 'UPDATED';
          break;
        default:
          break;
      }

      pubsub.publish(mutationName, {
        mutation: mutationType,
        node: subsData,
        previousValues: preData,
        // updatedFields: [] // TODO: implement
      });

      return res;
    };

    let res;

    if (opType == 'add' || opType == 'set') {
      let _name, _op;

      if (_source.through && _source.through.model) {
        delete _args[name][_source.target.name];
        delete _args[name][_source.foreignIdentifierField];
        _name = assocSuffix(_source.target, ['BelongsTo', 'HasOne'].indexOf(_source.associationType) < 0, _source.as);
        _op = opType + _name;
      } else {
        _name = assocSuffix(_model, ['BelongsTo', 'HasOne'].indexOf(_source.associationType) < 0, _source.as);
        _op = opType + _name;
      }

      res = await sourceInst[_op](assocInst, opType == 'add' ? {
        through: _args[name],
        transaction
      } : {
        transaction
      });

      return finalize(res);

    }
    let updWhere = {};

    switch (opType) {
      case 'upsert':
        for (const k in _model.primaryKeyAttributes) {
          const pk = _model.primaryKeyAttributes[k];

          // not association case
          if (!_args[name][pk]) {
            opType = 'create';
            updWhere = where;
            break;
          }

          updWhere[pk] = _args[name][pk];
        }
        break;
      case 'update':
        updWhere = where;
        break;
      default:
        break;
    }

    // allow destroy on instance if specified
    const _inst = toDestroy && opType == 'destroy' ? toDestroy : _model;

    res = await _inst[opType](opType === 'destroy' ? {
      where,
      transaction
    } : _args[name], {
      where,
      validate,
      transaction
    });

    if (opType !== 'create' && opType !== 'destroy') {
      return finalize(await _model.findOne({ where: updWhere, transaction }));
    }

    return finalize(res);

  };

  const createAssoc = async (_source, _sourceInst, _args, transaction) => {
    const _data = {};

    const processAssoc = async (aModel, name, fields, isList) => {
      if (typeof fields === 'object' && aModel) {

        const _a = {
          [name]: fields,
          transaction
        };

        if (aModel.associationType === 'BelongsToMany') {
          const _model = aModel.through.model;

          const fkName = aModel.foreignIdentifierField;
          const crObj = fields[aModel.target.name];
          const fkVal = fields[fkName];


          if (crObj && fkVal) {
            return Promise.reject(new Error(`Cannot define both foreignKey for association (${fkVal}) AND Instance for creation (${crObj}) in your mutation!`));
          } else if (!crObj && !fkVal) {
            return Promise.reject(new Error(`You must specify foreignKey for association (${fkName}) OR Instance for creation (${aModel.target.name}) in your mutation!`));
          }

          if (crObj) {
            const _at = {
              [aModel.target.name]: crObj,
              transaction
            };
            const node = await operation(operationType === 'update' ? 'upsert' : 'create', aModel.target, _model, _at, aModel.target.name, null, _sourceInst, transaction);
            const data = await operation('add', _model, aModel, _a, name, node, _sourceInst, transaction);
            const edge = data[0][0];

            edge[aModel.target.name] = node;

            return { [_model.name]: edge };
          }
          const data = await operation('add', _model, aModel, _a, name, fkVal, _sourceInst, transaction);


          return { [_model.name]: data[0][0] };

        }
        const _model = aModel.target;
        const newInst = await operation(operationType === 'update' ? 'upsert' : 'create', _model, aModel.target, _a, name, {}, _sourceInst, transaction);

        await operation(aModel.associationType === 'BelongsTo' ? 'set' : 'add', _model, aModel, _a, name, newInst, _sourceInst, transaction);

        return newInst;

      }

      return null;
    };

    for (const name in _args) {
      // eslint-disable-next-line no-continue
      if (!_source.associations) continue;

      const aModel = _source.associations[name];

      if (Array.isArray(_args[name])) {
        _data[name] = [];

        if (args['set'] == true) {
          const _refModel = _source.through && _source.through.model ? _source.target : aModel.target;
          const _name = assocSuffix(_refModel, true, aModel.as);

          if (aModel.associationType === 'HasMany' || aModel.associationType === 'HasOne') {

            // we cannot use set() to remove because of a bug: https://github.com/sequelize/sequelize/issues/8588
            const _getOp = 'get' + _name;
            // eslint-disable-next-line no-await-in-loop
            const assoc = await _sourceInst[_getOp]({ transaction });

            if (assoc) {
              const toUpdate = (inst) => {
                for (const p in _args[name]) {
                  const obj = _args[name][p];
                  let found;

                  for (const k in aModel.target.primaryKeyAttributes) {
                    found = true;
                    const pk = aModel.target.primaryKeyAttributes[k];

                    if (obj[pk] != inst[pk]) {
                      found = false;
                      break;
                    }
                  }

                  if (found) {
                    return true;
                  }
                }

                return false;
              };

              let v;

              if (_.isArray(assoc)) {
                for (const k in assoc) {
                  v = assoc[k];
                  // eslint-disable-next-line max-depth
                  if (!toUpdate(v))
                    // eslint-disable-next-line no-await-in-loop
                    await operation('destroy', aModel.target, _source, [], null, null, _sourceInst, transaction, v);
                }
              } else if (!toUpdate(assoc)) {
                // eslint-disable-next-line no-await-in-loop
                await operation('destroy', aModel.target, _source, [], null, null, _sourceInst, transaction, v);
              }
            }
          } else {
            const _op = 'set' + _name;

            // eslint-disable-next-line no-await-in-loop
            await _sourceInst[_op]([], { transaction });
          }
        }

        for (const p in _args[name]) {
          const obj = _args[name][p];
          // eslint-disable-next-line no-await-in-loop
          const newInst = await processAssoc(aModel, name, obj, true);

          if (newInst) {
            _data[name].push(newInst);
          }
        }
      } else {
        // eslint-disable-next-line no-await-in-loop
        const newInst = await processAssoc(aModel, name, _args[name], false);

        if (newInst) {
          _data[name] = newInst;
        }
      }
    }

    return _data;
  };

  if (args['transaction']) {
    data = await Models.sequelize.transaction((transaction) => {
      context.transaction = transaction;

      return operation(operationType, model, source, args, inputTypeName, null, null, transaction);
    });
  } else {
    data = await operation(operationType, model, source, args, inputTypeName, null, null);
  }

  await options.logger(data, source, args, context, info);

  if (isBulk) {
    return args[inputTypeName].length;
  }

  return type == 'destroy' ? parseInt(data) : data;

};

const subscriptionResolver = (model) => {
  return async (data, args, context, info) => {
    if (args.where) whereQueryVarsToValues(args.where, info.variableValues);

    if (_.has(model.graphql.extend, 'subscription')) {
      const subData = await model.graphql.extend['subscription'](data, null, args, context, info, null);

      return subData;
    }

    return data;

  };
};


function fixIds(
  model,
  fields,
  assoc,
  source,
  isUpdate
) {
  const newId = (modelName, allowNull = false) => {
    return {
      name: 'id',
      description: `The ID for ${modelName}`,
      type: allowNull ? GraphQLInt : new GraphQLNonNull(GraphQLInt)
    };
  };

  // Fix Relay ID
  const rawAttributes = model.rawAttributes;

  _.each(Object.keys(rawAttributes), (key) => {
    if (key === 'clientMutationId') {
      return;
    }
    // Check if reference attribute
    const attr = rawAttributes[key];

    if (!attr) {
      return;
    }
    if (attr.references) {
      const modelName = attr.references.model;

      fields[key] = newId(modelName, isUpdate || (assoc || attr.allowNull));
    } else if (attr.autoIncrement) {
      // Make autoIncrement fields optional (allowNull=True)
      fields[key] = newId(model.name, true);
    }
  });
}

const sanitizeFieldName = (type) => {

  const isRequired = type.indexOf('!') > -1;
  const isArray = type.indexOf('[') > -1;

  type = type.replace('[', '');
  type = type.replace(']', '');
  type = type.replace('!', '');

  return {
    type,
    isArray,
    isRequired
  };
};

const generateGraphQLField = (type) => {

  const typeReference = sanitizeFieldName(type);
  let field = getTypeByString(typeReference.type);

  if (!field) field = GraphQLString;
  if (typeReference.isArray) field = new GraphQLList(field);
  if (typeReference.isRequired) field = GraphQLNonNull(field);

  return { type: field };
};

const toGraphQLType = function (name, schema) {

  const fields = {};

  for (const field in schema) {
    fields[field] = generateGraphQLField(schema[field]);
  }

  return new GraphQLObjectType({
    name,
    fields: () => fields
  });

};

const generateTypesFromObject = function (remoteData) {

  const types = {};
  let queries = [];

  remoteData.forEach((item) => {

    for (const type in item.types) {
      types[type] = toGraphQLType(type, item.types[type]);
    }
    item.queries.forEach((query) => {
      const args = {};

      for (const arg in query.args) {
        args[arg] = generateGraphQLField(query.args[arg]);
      }
      query.args = args;
    });
    queries = queries.concat(item.queries);
  });

  return {
    types,
    queries
  };

};

function getBulkOption(options, key) {
  const bulkOption = options.filter((option) => (Array.isArray(option) ? option[0] == key : option == key));

  return bulkOption.length ? (Array.isArray(bulkOption[0]) ? bulkOption[0][1] : true) : false;
}

/**
 * Returns the association fields of an entity.
 *
 * It iterates over all the associations and produces an object compatible with GraphQL-js.
 * BelongsToMany and HasMany associations are represented as a `GraphQLList` whereas a BelongTo
 * is simply an instance of a type.
 * @param {*} associations A collection of sequelize associations
 * @param {*} types Existing `GraphQLObjectType` types, created from all the Sequelize models
 */
const generateAssociationFields = (model, associations, types, cache, isInput = false, isUpdate = false, assoc = null, source = null) => {
  const fields = {};

  const buildAssoc = (assocModel, relation, associationType, associationName, foreign = false) => {
    if (!types[assocModel.name]) {
      //if (assocModel != source) { // avoid circular loop
      types[assocModel.name] = generateGraphQLType(assocModel, types, cache, isInput, isUpdate, assocModel, source);
      //} else
      //  return fields;
    }

    if (!associationName) // edge case
      return false;

    // BelongsToMany is represented as a list, just like HasMany
    const type = associationType === 'BelongsToMany' ||
      associationType === 'HasMany'
      ? new GraphQLList(types[assocModel.name])
      : types[assocModel.name];

    fields[associationName] = {
      type
    };

    if (isInput) {
      if (associationType === 'BelongsToMany') {
        const aModel = relation.through.model;

        if (!aModel.graphql)
          aModel.graphql = defaultModelGraphqlOptions;
        // if n:m join table, we have to create the connection input type for it
        const _name = getTypeName(aModel, isInput, false, true);

        if (!types[_name]) {
          const gqlType = generateGraphQLType(aModel, types, cache, isInput, false, assocModel, model);

          gqlType.name = _name;
          types[_name] = new GraphQLList(gqlType);
        }
        fields[associationName].type = types[_name];
      }
    } else if (!relation.isRemote) {
      // 1:1 doesn't need connectionFields
      if (['BelongsTo', 'HasOne'].indexOf(associationType) < 0) {
        let edgeFields = {};

        if (associationType === 'BelongsToMany') {
          const aModel = relation.through.model;

          if (!aModel.graphql)
            aModel.graphql = defaultModelGraphqlOptions;

          let exclude = aModel.graphql.attributes.exclude;

          exclude = Array.isArray(exclude) ? exclude : exclude['fetch'];

          let only = aModel.graphql.attributes.only;

          only = Array.isArray(only) ? only : only['fetch'];

          edgeFields = Object.assign(attributeFields(aModel, {
            exclude,
            only,
            commentToDescription: true,
            cache
          }), types[assocModel.name].args);

          // Pass Through model to resolve function
          _.each(edgeFields, (edgeField, field) => {
            edgeField.resolve = queryResolver(aModel, true, field);
          });
        }

        const connection = sequelizeConnection({
          name: model.name + associationName,
          nodeType: types[assocModel.name],
          target: relation,
          connectionFields: {
            total: {
              type: new GraphQLNonNull(GraphQLInt),
              description: `Total count of ${assocModel.name} results associated with ${model.name} with all filters applied.`,
              resolve: (source, args, context, info) => {
                return source.edges.length;
              }
            },
            count: {
              type: new GraphQLNonNull(GraphQLInt),
              description: `Total count of ${assocModel.name} results associated with ${model.name} without limits applied.`,
              resolve: (source, args, context, info) => {
                if (!source.__parent)
                  return 0;

                const _args = argsToFindOptions.default(source.__args);
                const where = _args['where'];
                const suffix = assocSuffix(assocModel, ['BelongsTo', 'HasOne'].indexOf(associationType) < 0, associationName);


                return source.__parent['count' + suffix]({
                  where
                });
              }
            }
          },
          edgeFields
        });

        connection.resolve = queryResolver(relation, true, null, assocModel);

        fields[associationName].type = connection.connectionType;
        fields[associationName].args = Object.assign(defaultArgs(relation), defaultListArgs(), {
          whereEdges: defaultListArgs().where,
          orderEdges: defaultListArgs().order
        }, connection.connectionArgs);
        fields[associationName].resolve = connection.resolve;
      } else {
        // GraphQLInputObjectType do not accept fields with resolve
        fields[associationName].args = Object.assign(defaultArgs(relation), defaultListArgs(), types[assocModel.name].args);
        fields[associationName].resolve = queryResolver(relation, true);
      }
    } else {
      fields[associationName].args = Object.assign({}, relation.query.args, defaultListArgs());
      fields[associationName].resolve = (source, args, context, info) => {
        return remoteResolver(source, args, context, info, relation.query, fields[associationName].args, types[assocModel.name]);
      };
    }

    return false;
  };

  for (const associationName in associations) {
    const relation = associations[associationName];
    const res = buildAssoc(relation.target, relation, relation.associationType, associationName);

    if (res) return res;
  }

  //Discovers hidden relations that are implicit created
  // (for example for join table in n:m case)
  const rawAttributes = model.rawAttributes;

  for (const key in rawAttributes) {
    if (key === 'clientMutationId') {
      return;
    }

    const attr = rawAttributes[key];

    if (attr && attr.references) {
      const modelName = attr.references.model;
      const assocModel = model.sequelize.modelManager.getModel(modelName, {
        attribute: 'tableName'
      });

      // TODO: improve it or ask sequelize community to fix it
      // ISSUE: belongsToMany
      // when you have to create the association resolvers for
      // a model used as "through" for n:m relation
      // our library cannot find the correct information
      // since the association from "through" table to the target
      // is not created by Sequelize. So we've to create it here
      // to allow graphql-sequelize understand how to build the query.
      // example of the issue:
      // tableA belongsToMany tableB (through tableC)
      // tableC doesn't belongsTo tableB and tableA
      // so graphql-sequelize resolver is not able to understand how to
      // build the query.
      // HACK-FIX(?):
      if (!model.associations[assocModel.name]) {
        model.belongsTo(assocModel, {
          foreignKey: attr.field
        });
      }

      const reference = model.associations[assocModel.name];

      buildAssoc(assocModel, reference, 'BelongsTo', reference.name || reference.as, true);
    }
  }

  return fields;
};

const generateIncludeAttributes = (model, types, isInput = false) => {
  const includeAttributes = {};

  if (model.graphql.attributes.include) {
    for (const attribute in model.graphql.attributes.include) {
      let type = null;
      const typeName = model.graphql.attributes.include[attribute] + (isInput ? 'Input' : '');

      if (types && types[typeName]) {
        type = {
          type: types[typeName]
        };
      }

      if (!type && model.graphql.types && model.graphql.types[typeName]) {
        type = generateGraphQLField(model.graphql.types[typeName]);
      }

      includeAttributes[attribute] = type || generateGraphQLField(typeName);
    }
  }

  return includeAttributes;
};

const generateGraphQLFields = (model, types, cache, isInput = false, isUpdate = false, assoc = null, source = null) => {
  let exclude = model.graphql.attributes.exclude;

  exclude = Array.isArray(exclude) ? exclude : exclude[!isInput ? 'fetch' : isUpdate ? 'update' : 'create'];

  let only = model.graphql.attributes.only;

  only = Array.isArray(only) ? only : only[!isInput ? 'fetch' : isUpdate ? 'update' : 'create'];

  const fields = Object.assign(
    attributeFields(model, Object.assign({}, {
      exclude,
      only,
      allowNull: !isInput || isUpdate,
      checkDefaults: isInput,
      commentToDescription: true,
      cache
    })),
    generateAssociationFields(model, model.associations, types, cache, isInput, isUpdate, assoc, source),
    generateIncludeAttributes(model, types, isInput)
  );

  if (assoc && ((model.name == assoc.name && model.associations[assoc.name]) || model.name != assoc.name)) {

    if (!types[assoc.name]) {
      types[assoc.name] = generateGraphQLType(assoc, types, cache, isInput, isUpdate, assoc, source);
    }

    fields[assoc.name] = {
      name: getTypeName(assoc, isInput, isUpdate, false),
      type: types[assoc.name]
    };
  }

  fields['_SeqGQLMeta'] = {
    type: GraphQLString
  };

  if (isInput) {
    fixIds(model, fields, assoc, source, isUpdate);

    // FIXME: Handle timestamps
    // console.log('_timestampAttributes', Model._timestampAttributes);
    delete fields.createdAt;
    delete fields.updatedAt;
  }

  return fields;
};

/**
 * Returns a new `GraphQLObjectType` created from a sequelize model.
 *
 * It creates a `GraphQLObjectType` object with a name and fields. The
 * fields are generated from its sequelize associations.
 * @param {*} model The sequelize model used to create the `GraphQLObjectType`
 * @param {*} types Existing `GraphQLObjectType` types, created from all the Sequelize models
 */
const generateGraphQLType = (model, types, cache, isInput = false, isUpdate = false, assoc = null, source = null) => {
  const GraphQLClass = isInput ? GraphQLInputObjectType : GraphQLObjectType;

  const thunk = () => {
    return generateGraphQLFields(model, types, cache, isInput, isUpdate, assoc, source);
  };

  const fields = assoc ? thunk : thunk();

  const name = getTypeName(model, isInput, isUpdate, assoc);
  // can be already created by generateGraphQLFields recursion

  if (types[model.name] && types[model.name].name == name)
    return types[model.name];

  return new GraphQLClass({
    name,
    fields
  });
};

// eslint-disable-next-line no-unused-vars
const getCustomType = (model, type, customTypes, isInput, ignoreInputCheck = false) => {

  const fields = {};

  if (typeof model.graphql.types[type] === 'string') {
    return generateGraphQLField(model.graphql.types[type]);
  }

  for (const field in model.graphql.types[type]) {

    const fieldReference = sanitizeFieldName(model.graphql.types[type][field]);

    if (customTypes[fieldReference.type] !== undefined || model.graphql.types[fieldReference.type] != undefined) {
      let customField = customTypes[fieldReference.type] || getCustomType(model, fieldReference.type, customTypes, isInput, true);

      if (fieldReference.isArray) {
        customField = new GraphQLList(customField);
      }

      if (fieldReference.isRequired) {
        customField = GraphQLNonNull(customField);
      }

      fields[fieldReference.type] = {
        type: customField
      };

    } else {
      fields[field] = generateGraphQLField(model.graphql.types[type][field]);
    }

  }

  if (isInput && !ignoreInputCheck) {
    if (type.toUpperCase().endsWith('INPUT')) {
      return new GraphQLInputObjectType({
        name: type,
        fields: () => fields
      });
    }
  } else if (!type.toUpperCase().endsWith('INPUT')) {
    return new GraphQLObjectType({
      name: type,
      fields: () => fields
    });
  }

};

const generateCustomGraphQLTypes = (model, types, isInput = false) => {

  const typeCreated = {};
  const customTypes = {};

  const getCustomType = (type, ignoreInputCheck) => {

    const fields = {};

    //Enum
    if (Array.isArray(model.graphql.types[type])) {
      model.graphql.types[type].forEach((value) => {
        if (Array.isArray(value)) {
          fields[value[0]] = { value: value[1] };
        } else {
          fields[value] = { value: value };
        }
      });

      return new GraphQLEnumType({
        name: type,
        values: fields
      });
    }

    for (const field in model.graphql.types[type]) {

      const fieldReference = sanitizeFieldName(model.graphql.types[type][field]);

      if (customTypes[fieldReference.type] !== undefined || model.graphql.types[fieldReference.type] != undefined) {
        typeCreated[fieldReference.type] = true;

        let customField = customTypes[fieldReference.type] || getCustomType(fieldReference.type, true);

        if (fieldReference.isArray) {
          customField = new GraphQLList(customField);
        }

        if (fieldReference.isRequired) {
          customField = GraphQLNonNull(customField);
        }

        fields[fieldReference.type] = { type: customField };

      } else {
        typeCreated[type] = true;
        fields[field] = generateGraphQLField(model.graphql.types[type][field]);
      }

    }

    if (isInput && !ignoreInputCheck) {
      if (type.toUpperCase().endsWith('INPUT')) {
        return new GraphQLInputObjectType({
          name: type,
          fields: () => fields
        });
      }
    } else if (!type.toUpperCase().endsWith('INPUT')) {
      return new GraphQLObjectType({
        name: type,
        fields: () => fields
      });
    }

  };

  if (model.graphql && model.graphql.types) {

    for (const type in model.graphql.types) {

      customTypes[type] = getCustomType(type);

    }

  }

  return customTypes;
};

/**
 * Returns a collection of `GraphQLObjectType` generated from Sequelize models.
 *
 * It creates an object whose properties are `GraphQLObjectType` created
 * from Sequelize models.
 * @param {*} models The sequelize models used to create the types
 */
// This function is exported
const generateModelTypes = (models, remoteTypes) => {
  let outputTypes = remoteTypes || {};
  let inputTypes = {};
  const inputUpdateTypes = {};
  const cache = {};

  for (const modelName in models) {
    // Only our models, not Sequelize nor sequelize
    if (_.has(models[modelName], 'name') && modelName !== 'Sequelize') {
      outputTypes = Object.assign(outputTypes, generateCustomGraphQLTypes(models[modelName], null, false));
      inputTypes = Object.assign(inputTypes, generateCustomGraphQLTypes(models[modelName], null, true));
      outputTypes[modelName] = generateGraphQLType(models[modelName], outputTypes, cache, false, false, null, models[modelName]);
      inputTypes[modelName] = generateGraphQLType(models[modelName], inputTypes, cache, true, false, null, models[modelName]);
      inputUpdateTypes[modelName] = generateGraphQLType(models[modelName], inputTypes, cache, true, true, null, models[modelName]);
    }
  }

  return {
    outputTypes,
    inputTypes,
    inputUpdateTypes
  };
};

const generateModelTypesFromRemote = (context) => {
  if (options.remote) {

    const promises = [];

    for (const opt in options.remote.import) {

      options.remote.import[opt].headers = options.remote.import[opt].headers || options.remote.headers;
      promises.push(remoteSchema(options.remote.import[opt], context));

    }

    return Promise.all(promises);

  }

  return Promise.resolve(null);

};

/**
 * Returns a root `GraphQLObjectType` used as query for `GraphQLSchema`.
 *
 * It creates an object whose properties are `GraphQLObjectType` created
 * from Sequelize models.
 * @param {*} models The sequelize models used to create the root `GraphQLSchema`
 */
const generateQueryRootType = (models, outputTypes, inputTypes) => {

  const createQueriesFor = {};

  for (const outputTypeName in outputTypes) {
    if (models[outputTypeName]) {
      createQueriesFor[outputTypeName] = outputTypes[outputTypeName];
    }
  }

  return new GraphQLObjectType({
    name: 'Root_Query',
    fields: Object.keys(createQueriesFor).reduce((fields, modelTypeName) => {

      const modelType = outputTypes[modelTypeName];
      const queries = {
        [camelCase(modelType.name + 'Default')]: {
          type: GraphQLString,
          description: 'An empty default Query. Can be overwritten for your needs (for example metadata).',
          resolve: () => '1'
        },
      };

      const paranoidType = models[modelType.name].options.paranoid ? { paranoid: { type: GraphQLBoolean } } : {};

      const aliases = models[modelType.name].graphql.alias;

      if (models[modelType.name].graphql.excludeQueries.indexOf('count') === -1) {
        queries[camelCase(aliases.count || (modelType.name + 'Count'))] = {
          type: GraphQLInt,
          args: {
            where: defaultListArgs().where
          },
          resolve: (source, {
            where
          }, context, info) => {
            const args = argsToFindOptions.default({ where });

            if (args.where) whereQueryVarsToValues(args.where, info.variableValues);

            return models[modelTypeName].count({
              where: args.where
            });
          },
          description: 'A count of the total number of objects in this connection, ignoring pagination.'
        };
      }

      if (models[modelType.name].graphql.excludeQueries.indexOf('fetch') === -1) {
        queries[camelCase(aliases.fetch || (modelType.name + 'Get'))] = {
          type: new GraphQLList(modelType),
          args: Object.assign(defaultArgs(models[modelType.name]), defaultListArgs(), includeArguments(), paranoidType),
          resolve: queryResolver(models[modelType.name])
        };
      }

      if (models[modelTypeName].graphql && models[modelTypeName].graphql.queries) {

        for (const query in models[modelTypeName].graphql.queries) {

          //let outPutType = (queries[camelCase(query)] && queries[camelCase(query)].type) || GraphQLInt;
          const description = models[modelTypeName].graphql.queries[query].description || (queries[camelCase(query)] && queries[camelCase(query)].description) || null;
          let outPutType = GraphQLInt;
          let inPutType = GraphQLInt;
          let typeName = models[modelTypeName].graphql.queries[query].output;
          let inputTypeNameField = models[modelTypeName].graphql.queries[query].input;

          if (typeName) {

            const typeReference = sanitizeFieldName(typeName);
            const field = getTypeByString(typeReference.type);

            typeName = typeReference.type;

            if (typeReference.isArray) {
              outPutType = new GraphQLList(field || outputTypes[typeReference.type]);
            } else {
              outPutType = field || outputTypes[typeReference.type];
            }

          }

          if (inputTypeNameField) {

            const typeReference = sanitizeFieldName(inputTypeNameField);

            inputTypeNameField = typeReference.type;

            if (typeReference.isArray) {
              inPutType = new GraphQLList(inputTypes[inputTypeNameField]);
            } else {
              inPutType = inputTypes[inputTypeNameField];
            }

            if (typeReference.isRequired) {
              inPutType = GraphQLNonNull(inPutType);
            }
          }

          const inputArg = models[modelTypeName].graphql.queries[query].input ? { [inputTypeNameField]: { type: inPutType } } : defaultArgs(models[modelType.name]);

          queries[camelCase(query)] = {
            type: outPutType,
            description,
            args: Object.assign(inputArg, defaultListArgs(), includeArguments(), paranoidType),
            resolve: (source, args, context, info) => {
              return options.authorizer(source, args, context, info).then((_) => {
                return models[modelTypeName].graphql.queries[query].resolver(source, args, context, info);
              });
            }
          };
        }

      }

      return Object.assign(fields, queries);

    }, {})
  });
};

const generateMutationRootType = (models, inputTypes, inputUpdateTypes, outputTypes) => {

  const createMutationFor = {};

  for (const inputTypeName in inputTypes) {
    if (models[inputTypeName]) {
      createMutationFor[inputTypeName] = inputTypes[inputTypeName];
    }
  }

  return new GraphQLObjectType({
    name: 'Root_Mutations',
    fields: Object.keys(createMutationFor).reduce((fields, inputTypeName) => {

      const inputType = inputTypes[inputTypeName];
      const inputUpdateType = inputUpdateTypes[inputTypeName];
      const key = models[inputTypeName].primaryKeyAttributes[0];
      const aliases = models[inputTypeName].graphql.alias;

      const mutations = {
        [inputTypeName + 'Default']: {
          type: GraphQLInt,
          description: 'An empty default Mutation.',
          resolve: () => 1
        }
      };

      if (models[inputTypeName].graphql.excludeMutations.indexOf('create') === -1) {
        const mutationName = camelCase(aliases.create || (inputTypeName + 'Add'));

        mutations[mutationName] = {
          type: outputTypes[inputTypeName], // what is returned by resolve, must be of type GraphQLObjectType
          description: 'Create a ' + inputTypeName,
          args: Object.assign({
            [inputTypeName]: { type: inputUpdateType }
          }, includeArguments(), defaultMutationArgs()),
          resolve: (source, args, context, info) => mutationResolver(models[inputTypeName], inputTypeName, mutationName, source, args, context, info, 'create')
        };
      }

      if (models[inputTypeName].graphql.excludeMutations.indexOf('update') === -1) {
        const mutationName = camelCase(aliases.update || (inputTypeName + 'Edit'));

        mutations[mutationName] = {
          type: outputTypes[inputTypeName] || GraphQLInt,
          description: 'Update a ' + inputTypeName,
          args: Object.assign({
            [key]: { type: new GraphQLNonNull(GraphQLInt) },
            where: defaultListArgs().where,
            [inputTypeName]: {
              type: inputUpdateType
            }
          }, includeArguments(), defaultMutationArgs()),
          resolve: (source, args, context, info) => {
            const where = {
              ...args['where'],
              [key]: args[key]
            };

            return mutationResolver(models[inputTypeName], inputTypeName, mutationName, source, args, context, info, 'update', where).
              then((boolean) => {
                // `boolean` equals the number of rows affected (0 or 1)
                return resolver(models[inputTypeName], {
                  [EXPECTED_OPTIONS_KEY]: dataloaderContext
                })(source, where, context, info);
              });
          }
        };
      }

      if (models[inputTypeName].graphql.excludeMutations.indexOf('destroy') === -1) {
        const mutationName = camelCase(aliases.destroy || (inputTypeName + 'Delete'));

        mutations[mutationName] = {
          type: GraphQLInt,
          description: 'Delete a ' + inputTypeName,
          args: Object.assign({
            [key]: { type: new GraphQLNonNull(GraphQLInt) },
            where: defaultListArgs().where
          }, includeArguments(), defaultMutationArgs()),
          resolve: (source, args, context, info) => {
            const where = {
              ...args['where'],
              [key]: args[key]
            };


            return mutationResolver(models[inputTypeName], inputTypeName, mutationName, source, args, context, info, 'destroy', where);
          }
        };
      }

      const hasBulkOptionCreate = getBulkOption(models[inputTypeName].graphql.bulk, 'create');
      const hasBulkOptionEdit = getBulkOption(models[inputTypeName].graphql.bulk, 'edit');
      const hasBulkOptionDelete = getBulkOption(models[inputTypeName].graphql.bulk, 'delete');

      if (hasBulkOptionCreate) {
        mutations[camelCase(aliases.create || (inputTypeName + 'AddBulk'))] = {
          type: (typeof hasBulkOptionCreate === 'string') ? new GraphQLList(outputTypes[inputTypeName]) : GraphQLInt, // what is returned by resolve, must be of type GraphQLObjectType
          description: 'Create bulk ' + inputTypeName + ' and return number of rows or created rows.',
          args: Object.assign({ [inputTypeName]: { type: new GraphQLList(inputType) } }, includeArguments()),
          resolve: (source, args, context, info) => mutationResolver(models[inputTypeName], inputTypeName, source, args, context, info, 'create', null, hasBulkOptionCreate)
        };
      }

      if (hasBulkOptionDelete) {
        const mutationName = camelCase(aliases.bulkDelete || (inputTypeName + 'DeleteBulk'));

        mutations[mutationName] = {
          type: GraphQLInt, // what is returned by resolve, must be of type GraphQLObjectType
          description: 'Delete bulk ' + inputTypeName + ' and return number of rows deleted.',
          args: Object.assign({
            where: defaultListArgs().where,
            [key]: {
              type: new GraphQLList(new GraphQLNonNull(GraphQLInt))
            },
          }, includeArguments(), defaultMutationArgs()),
          resolve: (source, args, context, info) => {
            const where = {
              ...args['where'],
              [key]: args[key]
            };

            return mutationResolver(models[inputTypeName], key, mutationName, source, args, context, info, 'destroy', where, true);
          }
        };
      }

      if (hasBulkOptionEdit) {

        mutations[camelCase(aliases.edit || (inputTypeName + 'EditBulk'))] = {
          type: outputTypes[inputTypeName] ? new GraphQLList(outputTypes[inputTypeName]) : GraphQLInt, // what is returned by resolve, must be of type GraphQLObjectType
          description: 'Update bulk ' + inputTypeName + ' and return number of rows modified or updated rows.',
          args: Object.assign({ [inputTypeName]: { type: new GraphQLList(inputType) } }, includeArguments()),
          resolve: async (source, args, context, info) => {
            const whereClause = { [key]: { [Models.Sequelize.Op.in]: args[inputTypeName].map((input) => input[key]) } };

            await mutationResolver(models[inputTypeName], inputTypeName, source, args, context, info, 'update', null, hasBulkOptionEdit);

            return resolver(models[inputTypeName], { [EXPECTED_OPTIONS_KEY]: dataloaderContext })(source, whereClause, context, info);
          }
        };
      }

      if (models[inputTypeName].graphql && models[inputTypeName].graphql.mutations) {

        for (const mutation in models[inputTypeName].graphql.mutations) {

          let isArray = false;
          let outPutType = GraphQLInt;
          let inPutType = GraphQLInt;
          let typeName = models[inputTypeName].graphql.mutations[mutation].output;
          let inputTypeNameField = models[inputTypeName].graphql.mutations[mutation].input;

          if (typeName) {

            const typeReference = sanitizeFieldName(typeName);

            typeName = typeReference.type;
            isArray = typeReference.isArray;

            if (isArray) {
              outPutType = new GraphQLList(outputTypes[typeName]);
            } else {
              outPutType = outputTypes[typeName];
            }

          }

          if (inputTypeNameField) {

            const typeReference = sanitizeFieldName(inputTypeNameField);

            inputTypeNameField = typeReference.type;

            if (typeReference.isArray) {
              inPutType = new GraphQLList(inputTypes[inputTypeNameField]);
            } else {
              inPutType = inputTypes[inputTypeNameField];
            }

            if (typeReference.isRequired) {
              inPutType = GraphQLNonNull(inPutType);
            }
          }

          mutations[camelCase(mutation)] = {
            type: outPutType,
            args: Object.assign({ [inputTypeNameField]: { type: inPutType } }, includeArguments()),
            resolve: (source, args, context, info) => {
              const where = key && args[inputTypeName] ? {
                [key]: args[inputTypeName][key]
              } : {};


              return options.authorizer(source, args, context, info).then((_) => {
                return models[inputTypeName].graphql.mutations[mutation].resolver(source, args, context, info, where);
              }).then((data) => {
                return options.logger(data, source, args, context, info).then(() => data);
              });
            }
          };
        }

      }

      const toReturn = Object.assign(fields, mutations);

      return toReturn;

    }, {})
  });
};

const generateSubscriptionRootType = (models, inputTypes, inputUpdateTypes, outputTypes) => {

  const createSubsFor = {};

  for (const inputTypeName in inputTypes) {
    if (models[inputTypeName]) {
      createSubsFor[inputTypeName] = inputTypes[inputTypeName];
    }
  }

  const mutationTypes = new GraphQLEnumType({
    name: 'mutationTypes',
    values: {
      CREATED: { value: 'CREATED' },
      BULK_CREATED: { value: 'BULK_CREATED' },
      DELETED: { value: 'DELETED' },
      UPDATED: { value: 'UPDATED' }
    }
  });

  return new GraphQLObjectType({
    name: 'Root_Subscription',
    fields: Object.keys(createSubsFor).reduce((fields, inputTypeName) => {

      const key = models[inputTypeName].primaryKeyAttributes[0];
      const aliases = models[inputTypeName].graphql.alias;

      const subscriptions = {};

      {
        const hasBulkOptionCreate = getBulkOption(models[inputTypeName].graphql.bulk, 'create');
        const _filter = models[inputTypeName].graphql.subsFilter.default;
        const filter = _filter ? _filter : () => true;
        const subsName = camelCase(aliases.subscribe || (inputTypeName + 'Subs'));

        subscriptions[subsName] = {
          type: new GraphQLObjectType({
            name: subsName + 'Output',
            fields: {
              mutation: { type: mutationTypes },
              node: {
                type: outputTypes[inputTypeName], // what is returned by resolve, must be of type GraphQLObjectType
              },
              updatedFields: { type: new GraphQLList(GraphQLString) },
              previousValues: { type: outputTypes[inputTypeName] }
            }
          }),
          description: 'On creation/update/delete of ' + inputTypeName,
          args: {
            mutation: { type: new GraphQLList(mutationTypes) }
          },
          subscribe: withFilter((rootValue, args, context, info) => {

            const filterType = [];

            if ((!args.mutation || args.mutation.indexOf("CREATED") >= 0)
              && models[inputTypeName].graphql.excludeSubscriptions.indexOf('create') === -1)
              filterType.push(camelCase(inputTypeName + 'Add'))

            if ((!args.mutation || args.mutation.indexOf("UPDATED") >= 0)
              && models[inputTypeName].graphql.excludeSubscriptions.indexOf('update') === -1)
              filterType.push(camelCase(inputTypeName + 'Edit'))

            if ((!args.mutation || args.mutation.indexOf("DELETED") >= 0)
              && models[inputTypeName].graphql.excludeSubscriptions.indexOf('destroy') === -1)
              filterType.push(camelCase(inputTypeName + 'Delete'))

            if ((!args.mutation || args.mutation.indexOf("BULK_CREATED") >= 0)
              && hasBulkOptionCreate)
              filterType.push(camelCase(inputTypeName + 'AddBulk'))

            return pubsub.asyncIterator(filterType);
          }, filter),
          resolve: subscriptionResolver(models[inputTypeName])
        };
      }

      if (models[inputTypeName].graphql && models[inputTypeName].graphql.subscriptions) {

        for (const subscription in models[inputTypeName].graphql.subscriptions) {

          let isArray = false;
          let outPutType = GraphQLInt;
          let typeName = models[inputTypeName].graphql.subscriptions[subscription].output;

          if (typeName) {
            if (typeName.startsWith('[')) {
              typeName = typeName.replace('[', '');
              typeName = typeName.replace(']', '');
              isArray = true;
            }

            if (isArray) {
              outPutType = new GraphQLList(outputTypes[typeName]);
            } else {
              outPutType = outputTypes[typeName];
            }
          }

          subscriptions[camelCase(subscription)] = {
            type: outPutType,
            args: Object.assign({
              [models[inputTypeName].graphql.subscriptions[subscription].input]: {
                type: inputTypes[models[inputTypeName].graphql.subscriptions[subscription].input]
              }
            }, includeArguments()),
            resolve: (source, args, context, info) => {
              const where = key && args[inputTypeName] ? {
                [key]: args[inputTypeName][key]
              } : {};


              return options.authorizer(source, args, context, info).then((_) => {
                return models[inputTypeName].graphql.subscriptions[subscription].resolver(source, args, context, info, where);
              }).then((data) => {
                return data;
              });
            },
            subscribe: models[inputTypeName].graphql.subscriptions[subscription].subscriber
          };
        }

      }

      const toReturn = Object.assign(fields, subscriptions);

      return toReturn;

    }, {})
  });
};

// This function is exported
const generateSchema = (models, types, context, Sequelize) => {

  Models = models;
  Sequelize = models.Sequelize || Sequelize;

  if (options.dataloader) dataloaderContext = createContext(models.sequelize);
  if (Sequelize) {
    Sequelize.useCLS(sequelizeNamespace);
  } else {
    console.warn('Sequelize not found at Models.Sequelize or not passed as argument. Automatic tranasctions for mutations are disabled.'); // eslint-disable-line no-console
    options.transactionedMutations = false;
  }

  const availableModels = {};

  for (const modelName in models) {
    models[modelName].graphql = models[modelName].graphql || defaultModelGraphqlOptions;
    models[modelName].graphql.attributes = Object.assign({}, defaultModelGraphqlOptions.attributes, models[modelName].graphql.attributes);
    models[modelName].graphql = Object.assign({}, defaultModelGraphqlOptions, models[modelName].graphql || {});
    if (options.exclude.indexOf(modelName) === -1) {
      availableModels[modelName] = models[modelName];
    }
  }

  if (options.remote && options.remote.import) {

    return generateModelTypesFromRemote(context).then((result) => {

      const remoteSchema = generateTypesFromObject(result);

      for (const modelName in availableModels) {
        if (availableModels[modelName].graphql.import) {

          availableModels[modelName].graphql.import.forEach((association) => {

            for (let index = 0; index < remoteSchema.queries.length; index++) {
              if (remoteSchema.queries[index].output === association.from) {
                availableModels[modelName].associations[(association.as || association.from)] = {
                  associationType: remoteSchema.queries[index].isList ? 'HasMany' : 'BelongsTo',
                  isRemote: true,
                  target: {
                    name: association.from
                  },
                  query: Object.assign({}, association, remoteSchema.queries[index])
                };
                break;
              }
            }

          });

        }

      }

      const modelTypes = types || generateModelTypes(availableModels, remoteSchema.types);

      //modelTypes.outputTypes = Object.assign({}, modelTypes.outputTypes, remoteSchema.types);

      return {
        query: generateQueryRootType(availableModels, modelTypes.outputTypes, modelTypes.inputTypes),
        mutation: generateMutationRootType(availableModels, modelTypes.inputTypes, modelTypes.inputUpdateTypes, modelTypes.outputTypes)
      };

    });

  }

  const modelTypes = types || generateModelTypes(availableModels);

  return {
    query: generateQueryRootType(availableModels, modelTypes.outputTypes, modelTypes.inputTypes),
    mutation: generateMutationRootType(availableModels, modelTypes.inputTypes, modelTypes.inputUpdateTypes, modelTypes.outputTypes),
    subscription: generateSubscriptionRootType(availableModels, modelTypes.inputTypes, modelTypes.inputUpdateTypes, modelTypes.outputTypes)
  };


};

module.exports = (_options) => {
  options = Object.assign(options, _options);

  return {
    generateGraphQLType,
    generateModelTypes,
    generateSchema,
    dataloaderContext,
    errorHandler,
    whereQueryVarsToValues,
    TRANSACTION_NAMESPACE,
    resetCache
  };
};
