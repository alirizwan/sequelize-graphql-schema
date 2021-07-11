
const _ = require('lodash');
const { GraphQLClient } = require('graphql-request');

module.exports = (options) => {

  return async (source, args, context, info, remoteQuery, remoteArguments, type) => {

    const availableArgs = _.keys(remoteQuery.args);
    const pickedArgs = _.pick(remoteArguments, availableArgs);
    const queryArgs = [];
    const passedArgs = [];

    for (const arg in pickedArgs) {
      if (pickedArgs[arg]) {
        queryArgs.push(`$${arg}:${pickedArgs[arg].type}`);
        passedArgs.push(`${arg}:$${arg}`);
      }
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
    const client = new GraphQLClient(remoteQuery.endpoint, { headers });
    const data = await client.request(query, variables);

    return data[remoteQuery.name];

  };

};