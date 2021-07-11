const _ = require('lodash');

async function restoreMutation (graphqlParams, mutationOptions) {

  const { args, context } = graphqlParams;
  const { isBulk, where, key, modelTypeName, models, transaction, skipBulkChecks } = mutationOptions;
  const model = models[modelTypeName];

  const scopeVariablePath = { args, context };
  const scope = Array.isArray(model.graphql.scopes) ? { method: [model.graphql.scopes[0], _.get(scopeVariablePath, model.graphql.scopes[1], model.graphql.scopes[2] || null)] } : model.graphql.scopes;

  // Unlikely to happen but still an extra check to not allow array of ids when destroying with non-bulk option.
  if (Array.isArray(where[key]) && !isBulk && !skipBulkChecks) {
    throw Error('Invalid operation input.');
  }

  await model.scope(scope).update({ deletedAt: null }, { where, transaction, paranoid: false });

  return model.scope(scope).findOne({ where, transaction });
}

module.exports = restoreMutation;