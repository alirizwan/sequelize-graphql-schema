const { GraphQLSchema, introspectionQuery } = require('graphql');
const express = require('express');
const graphqlHTTP = require('express-graphql');
const { generateSchema } = require('../src/sequelize-graphql-schema')({
  exclude: [],
  dataloader: true,
  nestedMutations: true
});

const app = express();
const models = require('./models');

app.use('/', (req, res) => {
  const schemaPromise = generateSchema(models, req);

  if (schemaPromise.then) {

    return schemaPromise.then((schema) => {
      return graphqlHTTP({
        schema: new GraphQLSchema(schema),
        graphiql: true
      })(req, res);
    });

  }

    return graphqlHTTP({
      schema: new GraphQLSchema(schemaPromise),
      graphiql: true
    })(req, res);


});

app.listen(3000, () => {
  console.log('RUNNING ON 3000');
});
