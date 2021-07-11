const { GraphQLSchema } = require('graphql');
const express = require('express');
const graphqlHTTP = require('express-graphql');
const graphcraft = require('../src/index');
const app = express();

module.exports = (models, options) => {

  app.use('/', async (req, res) => {
    
    const generateSchema = graphcraft(options);
    const schema = await generateSchema(models, req);
    
    return graphqlHTTP({
      schema: new GraphQLSchema(schema),
      graphiql: true
    })(req, res);

  });

  app.listen(3000);

  return app;

};