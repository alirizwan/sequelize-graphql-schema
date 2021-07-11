const _ = require('lodash');

function destroyMutation(graphqlParams, mutationOptions) {

  const { args, context } = graphqlParams;
  const { isBulk, where, key, modelTypeName, models, transaction, skipBulkChecks } = mutationOptions;
  const model = models[modelTypeName];

  // see if a scope is specified to be applied to find queries.
  const scopeVariablePath = { args, context };
  const scope = Array.isArray(model.graphql.scopes) ? { method: [model.graphql.scopes[0], _.get(scopeVariablePath, model.graphql.scopes[1], model.graphql.scopes[2] || null)] } : model.graphql.scopes;

  // Unlikely to happen but still an extra check to not allow array of ids when destroying with non-bulk option.
  if (Array.isArray(where[key]) && !isBulk && !skipBulkChecks) {
    throw Error('Invalid operation input.');
  }

  return model.scope(scope).destroy({ where, transaction });

}

module.exports = destroyMutation;