const _ = require('lodash');
const mutations = require('./mutations');
const hooks = require('./hooks');

function findOneRecord(model, where) {
  if (where) {
    return model.findOne({ where });
  }

  return Promise.resolve(null);

}

module.exports = (options) => {

  const { sequelize, Sequelize, nestedUpdateMode, globalHooks } = options;

  return async (source, args, context, info, mutationOptions) => {

    const { type, isBulk, modelTypeName, models, resolver, inputName } = mutationOptions;

    args[modelTypeName] = args[inputName] || args[modelTypeName];

    await options.authorizer(source, args, context, info);

    if (type === 'custom') {
      const data = await resolver(source, args, context, info);

      await options.logger(data, source, args, context, info);

      return data;
    }

    const model = models[modelTypeName];
    const key = model.primaryKeyAttributes[0];
    const where = { [key]: (['destroy', 'restore'].includes(type) ? args[key] : args[modelTypeName][key]) };

    if (globalHooks.before[type]) {
      await globalHooks.before[type](source, args, context, info, where);
    }

    // mutation being overwritten at graphql.overwrite.[create/destroy/update], run it and skip the rest
    if (_.has(model.graphql.overwrite, type)) {
      return model.graphql.overwrite[type](source, args, context, info, where);
    }

    const beforeHookResponse = await hooks.before(model, source, args, context, info, type, where);

    if (beforeHookResponse) {
      return beforeHookResponse;
    }

    const resolve = async (transaction) => {

      let data;

      const preparedOptions = { ...mutationOptions, where, transaction, key, nestedUpdateMode, Sequelize };
      const graphqlParams = { source, args, context, info };
      const previousRecord = await findOneRecord(model, !isBulk && (type === 'destroy' || type === 'update') ? where : null);

      context.previousData = previousRecord;

      if (mutations[type]) {

        data = await mutations[type](graphqlParams, preparedOptions);

      } else {
        throw Error('Invalid mutation.');
      }

      if (_.has(model.graphql.extend, type) || _.has(model.graphql.after, type)) {
        await (model.graphql.extend || model.graphql.after)[type](previousRecord || data, source, args, context, info, where);
      }

      if ((globalHooks.extend || globalHooks.extend || {})[type]) {
        await (globalHooks.extend || globalHooks.extend)[type](previousRecord || data, source, args, context, info, where);
      }

      return data;

    };

    let data;

    if (options.transactionedMutations && type !== 'custom') {

      data = await sequelize.transaction((transaction) => resolve(transaction));

    } else {

      data = await resolve();

    }

    await options.logger(data, source, args, context, info);

    return data;

  };

};