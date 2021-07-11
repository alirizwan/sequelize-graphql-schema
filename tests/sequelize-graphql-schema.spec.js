const { GraphQLSchema, introspectionQuery } = require('graphql');
const express = require('express');
const graphqlHTTP = require('express-graphql');
const { JSONType, DateType } = require('graphql-sequelize');
const {
  GraphQLBoolean
} = require('graphql');

const { generateSchema, resetCache } = require('../src/index')({
  exclude: [],
  dataloader: true,
  nestedMutations: true,
  restoreDeleted: true,
  limits: {
    default: 0,
    max: 0,
  },
  naming: {
    input: 'input',
  },
  findOneQueries: true,
  importTypes: {
    ImportCustomType: JSONType.default
  },
  types: {
    customGlobalType: { id: 'id', key: 'string', value: 'string' }
  },
  queries: {
    customGlobalQuery: { input: 'customGlobalType', output: '[customGlobalType]', resolver: () => { return [{ key: '1', value: '2' }]; } }
  },
  mutations: {
    customGlobalMutation: { input: 'customGlobalType', output: 'ImportCustomType', resolver: () => 1 }
  },
  globalHooks: {
    before: {
      create: () => {
        console.log('before global');
        return Promise.resolve();
      }
    },
    extend: {
      create: () => {
        console.log('extend global');
        return Promise.resolve();
      }
    }
  }
});

const app = express();
const models = require('./models');

app.use('/', async (req, res) => {
  
  const schema = await generateSchema(models, req);
  
  const response = await graphqlHTTP({
    schema: new GraphQLSchema(schema),
    graphiql: true
  })(req, res);

});

app.listen(3000, () => {
  console.log('RUNNING ON 3000');
});
