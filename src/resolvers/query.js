const _ = require('lodash');
const { resolver, argsToFindOptions } = require('graphql-sequelize');
const { EXPECTED_OPTIONS_KEY } = require('dataloader-sequelize');
const hooks = require('./hooks');
const { getIncludes, getOrderBy } = require('../utils');
const QUERY_TYPE = 'fetch';

module.exports = (options) => {

  const { dataloaderContext, limits, globalHooks, models } = options;

  return async (model, source, args, context, info, queryOptions) => {

    const isAssociation = Boolean(model.target);
    const realModel = isAssociation ? model.target : model;
    const graphql = realModel.graphql;
    const { simpleAST } = queryOptions;
    const includes = getIncludes(simpleAST, realModel.name, models);

    // setup dataloader for resolver.
    resolver.contextToOptions = { [EXPECTED_OPTIONS_KEY]: EXPECTED_OPTIONS_KEY };
    context[EXPECTED_OPTIONS_KEY] = dataloaderContext;

    if (!isAssociation) {
      args.limit = args.limit || (limits.default !== 0 && limits.default) || undefined;
      args.limit = (limits.max !== 0 && args.limit > limits.max) ? limits.max : args.limit;
    }

    // No need to call authorizer again on associations
    if (!isAssociation) await options.authorizer(source, args, context, info);

    if (globalHooks.before.fetch) {
      await globalHooks.before.fetch(source, args, context, info);
    }

    // query being overwritten at graphql.overwrite.fetch, run it and skip the rest
    if (_.has(graphql.overwrite, QUERY_TYPE)) {
      return graphql.overwrite[QUERY_TYPE](source, args, context, info);
    }

    // hook coming from graphql.before.fetch
    const beforeHookResponse = await hooks.before(isAssociation ? model.target : model, source, args, context, info, QUERY_TYPE);

    if (beforeHookResponse) {
      return beforeHookResponse;
    }

    // sequelize-graphql before hook to parse orderby clause to make sure it supports multiple orderby
    const before = (findOptions, args) => {

      if (isAssociation && model.through) {
        findOptions.through = {
          attributes: Object.keys(model.through.model.rawAttributes)
        };
      }

      if (args.throughWhere) {
        findOptions.where = argsToFindOptions.default({ where: args.throughWhere }, Object.keys(model.through.model.rawAttributes));
      }

      const order = getOrderBy(args.order);

      findOptions.order = order.length ? order : undefined;

      // if paranoid option from sequelize is set, this switch can be used to fetch archived, non-archived or all items.
      findOptions.paranoid = ((args.where && args.where.deletedAt && args.where.deletedAt.ne === null) || args.fetchDeleted) ? false : model.options.paranoid;

      if (includes.length) {
        findOptions.include = includes;
      }

      findOptions.gqlContext = context;

      return findOptions;
    };

    // see if a scope is specified to be applied to find queries.
    const variablePath = { args, context };
    const scope = Array.isArray(graphql.scopes) ? { method: [graphql.scopes[0], _.get(variablePath, graphql.scopes[1], graphql.scopes[2] || null)] } : graphql.scopes;
    const resolverOptions = {
      before,
      separate: isAssociation
    };

    const data = await resolver((isAssociation ? model : model.scope(scope)), resolverOptions)(source, args, context, info);

    if (_.has(graphql.extend, QUERY_TYPE) || _.has(graphql.after, QUERY_TYPE)) {
      await (graphql.extend || graphql.after)[QUERY_TYPE](data, source, args, context, info);
    }

    if ((globalHooks.extend || globalHooks.extend || {}).fetch) {
      await (globalHooks.extend || globalHooks.extend).fetch(data, source, args, context, info);
    }

    // Logger only runs for base query.
    if (!isAssociation) await options.logger(data, source, args, context, info);

    return data;

  };
};