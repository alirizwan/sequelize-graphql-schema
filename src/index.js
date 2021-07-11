const assert = require('assert');
const cls = require('cls-hooked');
const TRANSACTION_NAMESPACE = 'sequelize-graphql-schema';
const { createContext } = require('dataloader-sequelize');
const { define } = require('./utils');

// library options
const defaultOptions = {

  /**
   * naming convention for mutations/queries and types
   * {name} = Model Name or gql Type name
   * {type} = Get | Create | Update | Delete
   * {bulk} = Bulk (bulk operations only)
   * */

  naming: {
    pascalCase: true, // applied everywhere, set to true if you want to use camelCase
    queries: '{name}{type}', // applied to auto generated queries
    mutations: '{name}{type}{bulk}', // applied to auto generated mutations
    input: '{name}', // applied to all input types
    rootQueries: 'RootQueries',
    rootMutations: 'RootMutations',
    // {type} and {bulk} will be replaced with one of the following
    type: {
      create: 'Create',
      update: 'Update',
      delete: 'Delete',
      restore: 'Restore',
      byPk: 'ByPK',
      get: '',
      bulk: 'Bulk',
      count: 'Count',
      default: 'Default'
    }
  },

  // default limit to be applied on find queries
  limits: {
    default: 50, // default limit. use 0 for no limit
    max: 100, // maximum allowed limit. use 0 for unlimited
    nested: false // whether to apply these limits on nested/sub types or not
  },

  // nested objects can be passed and will be mutated automatically. Only hasMany and belongsTo relation supported
  nestedMutations: true, // doesn't work with add bulk mutation

  // applied globaly on both auto-generated and custom queries/mutations
  exposeOnly: {
    queries: [],
    mutations: [],
    // instead of not generating queries/mutations this will instead throw an error.
    throw: false // string message
  },
  // these models will be excluded from graphql schema
  exclude: [],
  // include these arguments to all queries/mutations
  includeArguments: {},
  // enabled/disable dataloader for nested queries
  dataloader: false,
  // mutations are run inside transactions. Transactions are accessible in extend hook
  transactionedMutations: true,
  // use this to import other non-supported graphql types such as Upload or anyother
  importTypes: {},
  // custom graphql types: type names should be unique throughout the project
  types: {},
  // custom queries: query names should be unique throughout the project
  queries: {},
  // custom mutations: mutation names should be unique throughout the project
  mutations: {},
  // global hooks, behaves same way as model before/extend
  globalHooks: {
    before: {}, // will be executed before all auto-generated mutations/queries (fetch/create/update/destroy)
    extend: {} // will be executed after all auto-generated mutations/queries (fetch/create/update/destroy)
  },
  findOneQueries: false, // create a find one query for each model (i.e. ProductByPk), which takes primary key (i.e. id) as argument and returns one item. Can also pass an array of models to create for specific models only (i.e. ['Product', 'Image'])
  fetchDeleted: false, // Globally when using queries, this will allow to fetch both deleted and undeleted records (works only when tables have paranoid option enabled)
  restoreDeleted: false, // Applies globally, create restore endpoint for deleted records
  noDefaults: true, // set it to false to generate empty default queries
  // executes after all queries/mutations
  logger() {
    return Promise.resolve();
  },
  // executes before all queries/mutations
  authorizer() {
    return Promise.resolve();
  },
  // executes when exceptions are thrown
  errorHandler: {
    'ETIMEDOUT': { statusCode: 503 }
  },
  debug: false
};

// Model options model.graphql
const defaultModelGraphqlOptions = {
  attributes: {
    exclude: [], // list attributes which are to be ignored in Model Input
    include: {}, // attributes in key:type format which are to be included in Model Input
  },
  // scope usage is highy recommended.
  scopes: null, // common scope to be applied on all find/update/destroy operations
  alias: {}, // rename default queries/mutations to specified custom name
  bulk: { // OR bulk: ['create', 'destroy', ....]
    enabled: [], // enable bulk options ['create', 'destroy', 'update']
    // Use bulkColumn when using bulk option for 'create' when using returning true and to increase efficiency
    bulkColumn: false, // bulk identifier column, when bulk creating this column will be auto filled with a uuid and later used to fetch added records 'columnName' or ['columnName', true] when using a foreign key as bulk column
    returning: true // This will return all created/updated items, doesn't use sequelize returning option
  },
  types: {}, // user defined custom types: type names should be unique throughout the project
  mutations: {}, // user defined custom mutations: : mutation names should be unique throughout the project
  queries: {}, // user defined custom queries: : query names should be unique throughout the project
  excludeMutations: [], // exclude one or more default mutations ['create', 'destroy', 'update']
  excludeQueries: [], // exclude one or more default queries ['fetch']
  extend: {}, // extend/after hook default queries/mutations behavior {fetch, create, destroy, update}
  before: {}, // before hook for default queries/mutations behavior {fetch, create, destroy, update}
  overwrite: {}, // overwrite default queries/mutations behavior {fetch, create, destroy, update}
  joins: false, // make a query using join (left/right/inner) instead of batch dataloader, join will appear in all subtype args. Right join won't work for sqlite
  readonly: false, // exclude create/delete/update mutations automatically
  fetchDeleted: false, // same as fetchDeleted as global except it lets you override global settings
  restoreDeleted: false // same as restoreDeleted as global except it lets you override global settings
};

const GenerateQueries = require('./libs/generateQueries');
const GenerateMutations = require('./libs/generateMutations');
const GenerateTypes = require('./libs/generateTypes');
const errorHandler = (options) => {

  return (error) => {

    for (const name in options.errorHandler) {
      if (error.message.indexOf(name) > -1) {
        Object.assign(error, options.errorHandler[name]);
        break;
      }
    }

    return error;

  };

};

function generateSchema(options) {

  return (models, context) => {
    assert(models.Sequelize, 'Sequelize not found as models.Sequelize.');
    assert(models.sequelize, 'sequelize instance not found as models.sequelize.');

    if (options.dataloader) {
      options.dataloaderContext = createContext(models.sequelize);
    }

    options.Sequelize = models.Sequelize;
    options.sequelize = models.sequelize;
    options.models = models;

    options.Sequelize.useCLS(cls.createNamespace(TRANSACTION_NAMESPACE));

    const { generateModelTypes } = GenerateTypes(options);
    const generateQueries = GenerateQueries(options);
    const generateMutations = GenerateMutations(options);
    const modelsIncluded = {};

    for (const modelName in models) {

      const model = models[modelName];

      if ('name' in model && modelName !== 'Sequelize' && !options.exclude.includes(modelName)) {
        model.graphql = model.graphql || defaultModelGraphqlOptions;
        model.graphql.attributes = Object.assign({}, defaultModelGraphqlOptions.attributes, model.graphql.attributes);
        model.graphql = Object.assign({}, defaultModelGraphqlOptions, model.graphql);
        modelsIncluded[modelName] = model;
      }

    }

    const modelTypes = generateModelTypes(modelsIncluded, {}, options);

    return Promise.resolve({
      query: generateQueries(modelsIncluded, modelTypes.outputTypes, modelTypes.inputTypes),
      mutation: generateMutations(modelsIncluded, modelTypes.outputTypes, modelTypes.inputTypes)
    });
  };


}

const init = (_options) => {

  const newOptions = { ..._options };

  newOptions.naming = Object.assign({}, defaultOptions.naming, newOptions.naming);
  newOptions.naming.type = Object.assign({}, defaultOptions.naming.type, newOptions.naming.type);
  newOptions.exposeOnly = Object.assign({}, defaultOptions.exposeOnly, newOptions.exposeOnly);
  newOptions.limits = Object.assign({}, defaultOptions.limits, newOptions.limits);

  const options = Object.assign({}, defaultOptions, newOptions);

  options.dataloaderContext = null;

  const resetCache = () => {
    if (options.dataloaderContext && options.dataloaderContext.loaders.autogenerated) {
      options.dataloaderContext.loaders.autogenerated.reset();
    }
  };

  return {
    generateSchema: generateSchema(options),
    // reset dataloader cache, recommended to be used at the end of each request when working with aws lambda
    resetCache,
    // use this to prime custom queries
    dataloaderContext: options.dataloaderContext,
    errorHandler: errorHandler(options)
  };
};

// Other utils that can be exported
// should be defined here
// TODO: maybe better to use a class
// export multiple things in the common way
init.define = define;

module.exports = init;
