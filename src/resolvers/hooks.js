const _ = require('lodash');

const before = (model, source, args, context, info, type, where) => {
  if (model.graphql && _.has(model.graphql, 'before') && _.has(model.graphql.before, type)) {
    return model.graphql.before[type](source, args, context, info, where);
  }

  return Promise.resolve();
};

module.exports = {
  before
};