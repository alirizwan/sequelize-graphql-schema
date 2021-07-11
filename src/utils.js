require('./jsdoc.def.js');
const camelCase = require('camelcase');
const { argsToFindOptions } = require('graphql-sequelize');
const REVERSE_CLAUSE_STRING = 'reverse:';
const ASC = 'ASC';
const DESC = 'DESC';

/**
 * This function will monkey-patch a Sequelize Model injecting the graphql property
 * for sequelize-graphql-schema library
 * @instance
 * @param {import("sequelize").Sequelize.Model} model - The sequelize model to monkey patch.
 * @param {SeqGraphQL} opt - object with all information needed for sequelize-graphql-schema and our node-platform lib.
 */
function define(model, opt) {
    model.graphql = opt;
}

function isFieldArray (name) {
  if (name.startsWith('[') && name.endsWith('!]')) return 3;
  if (name.startsWith('[') && name.endsWith(']!')) return 2;
  if (name.startsWith('[') && name.endsWith(']')) return 1;

  return 0;
}

function isFieldRequired (name) {
  return name.indexOf('!') > -1;
}

const sanitizeField = (name = '') => {

  if (name === '' || !name) throw Error('Invalid field name provided.');

  name = name.replace('[', '').replace(']', '').replace('!', '');

  if (name === '') throw Error('Invalid field name provided.');

  return name;
};

const tokenizeTemplate = (template, all) => {

  if (template.indexOf('{') === -1) {
    all.push(template);

    return;
  }

  const token = template.substr(0, template.indexOf(template.startsWith('{') ? '}' : '{') + (template.startsWith('{') ? 1 : 0));

  template = template.replace(token, '');
  all.push(token);
  tokenizeTemplate(template, all);
};

const generateName = (nameTemplate = '', map = {}, options = {}) => {

  if (nameTemplate === '' || nameTemplate === null) throw Error('Invalid name template.');

  const names = [];

  tokenizeTemplate(nameTemplate, names);

  const str = names.map((name) => {

    if (!name.startsWith('{')) return name;

    name = name.replace('{', '').replace('}', '');

    return map[name] || '';
  });

  if (options.noCase) return str.join('');

  return camelCase(str, { pascalCase: options.pascalCase });

};

function isAvailable(exposed, toBeGenerated) {

  const toGenerate = [].concat(toBeGenerated);

  if (!exposed.length) return true;

  for (let index = 0; index < toGenerate.length; index++) {
    if (exposed.includes(toGenerate[index])) {
      return true;
    }
  }

  return false;

}

const whereQueryVarsToValues = (o, vals) => {
  [
    ...Object.getOwnPropertyNames(o),
    ...Object.getOwnPropertySymbols(o)
  ].forEach((k) => {
    const obj = o[k];

    if (obj && obj.constructor && obj.call && obj.apply) {
      o[k] = o[k](vals);

      return;
    }

    const type = typeof obj;

    if (obj != null && (type == 'object' || type == 'function')) {
      whereQueryVarsToValues(o[k], vals);
    }
  });
};

const getIncludes = (ast, modelName, models) => {

  const includes = [];
  const model = models[modelName];

  for (const key in ast) {

    const args = ast[key].args || {};
    const join = args.join;
    const fieldsAst = ast[key].fields;
    const associations = model.associations;

    // check if it is really a association/model
    if (associations[key] && join) {

      const include = Object.assign({}, argsToFindOptions.default(args, Object.keys(associations[key].target.rawAttributes)), {
        model: associations[key].target,
        required: join === 'INNER',
        right: join === 'RIGHT',
        include: fieldsAst ? getIncludes(fieldsAst, key, models) : []
      });

      includes.push(include);

    }

  }

  return includes;

};

const getOrderBy = (orderArgs) => {

  const orderBy = [];

  if (orderArgs) {

    const orderByClauses = orderArgs.split(',');

    orderByClauses.forEach((clause) => {
      if (clause.indexOf(REVERSE_CLAUSE_STRING) === 0) {
        orderBy.push([clause.substring(REVERSE_CLAUSE_STRING.length), DESC]);
      } else {
        orderBy.push([clause, ASC]);
      }
    });

  }

  return orderBy;
};

function keysWhichAreModelAssociations (input, associations) {

  const keys = Object.keys(input);

  return keys.reduce((all, key) => {
    if (associations[key] && input[key] && input[key].length) {
      all.push({ key, target: associations[key].target, fields: [associations[key].foreignKey], through: associations[key].through ? associations[key].through.model : null }); // Using an array to support multiple keys in future.
    }

    return all;
  }, []);
}

module.exports = {
  define,
  isFieldArray,
  isFieldRequired,
  sanitizeField,
  generateName,
  isAvailable,
  whereQueryVarsToValues,
  getIncludes,
  getOrderBy,
  keysWhichAreModelAssociations
};