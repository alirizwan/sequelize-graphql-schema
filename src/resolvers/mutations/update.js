const _ = require('lodash');
const { keysWhichAreModelAssociations } = require('../../utils');
const { OPS } = require('../../constants');
const createMutation = require('./create');
const destroyMutation = require('./destroy');

function recursiveUpdateAssociations(graphqlParams, mutationOptions, options) {

  const { modelTypeName, models, Sequelize } = mutationOptions;
  const model = models[modelTypeName];
  const keys = model.primaryKeyAttributes;
  const { input, parentRecord, parentModel } = options;
  const parentKeys = parentModel.primaryKeyAttributes;
  const availableAssociations = keysWhichAreModelAssociations(input, model.associations);

  return Promise.all(availableAssociations.map((association) => {

    const recordsToAdd = [];
    const recordsToUpdate = [];
    const recordsToDestroy = [];
    // following are to be used for belongsToMany association
    const reverseAssociations = association.through ? association.target.associations : {};
    const reverseAssociationKeys = Object.keys(reverseAssociations).filter((key) => reverseAssociations[key].target.name === model.name);
    const reverseAssociationForeignKey = reverseAssociationKeys.length ? reverseAssociations[reverseAssociationKeys[0]].foreignKey : null;

    input[association.key].forEach((record) => {

      if (record[keys[0]]) {

        if (association.through) {

          const inputKeys = Object.keys(record);
          const recordForDelete = (record._Op === OPS.DELETE || record._Op === OPS.UPDATE) && inputKeys.length === 1 && inputKeys.includes(keys[0]);

          // check if association through input exists, if so it will be added as a new one as well as it will be deleted
          if (record[association.through.name] || (recordForDelete && !record[association.through.name])) {
            recordsToDestroy.push(
              {
                [association.fields[0]]: input[parentKeys[0]],
                [reverseAssociationForeignKey]: record[keys[0]]
              }
            );
          }

          if (record[association.through.name]) {
            recordsToAdd.push({
              ...record[association.through.name],
              [association.fields[0]]: input[parentKeys[0]],
              [reverseAssociationForeignKey]: record[keys[0]]
            });
          }

        } else if (record._Op === OPS.DELETE) {
          recordsToDestroy.push(record[keys[0]]);
        } else {
          recordsToUpdate.push(record);
        }

      } else if (record._Op === OPS.CREATE) {
        recordsToAdd.push(record);
      }

    });

    const newUpdateArgs = { [association.target.name]: recordsToUpdate };

    const operationsPromises = [];

    if (recordsToDestroy.length) {

      const where = association.through ? {
        [Sequelize.Op.or]: recordsToDestroy
      } : {
        [keys[0]]: {
          [Sequelize.Op.in]: recordsToDestroy
        },
        [association.fields[0]]: parentRecord[parentKeys[0]]
      };

      operationsPromises.push(
        destroyMutation({ ...graphqlParams }, { ...mutationOptions, modelTypeName: association.through ? association.through.name : association.target.name, isBulk: true, key: keys[0], where, skipBulkChecks: true })
      );

    }

    if (recordsToUpdate.length) {

      operationsPromises.push(
        updateMutation({ ...graphqlParams, args: newUpdateArgs }, { ...mutationOptions, modelTypeName: association.target.name, isBulk: true, skipReturning: true })
      );

    }

    if (recordsToAdd.length) {

      if (association.through) {

        const newCreateArgs = { [association.through.name]: recordsToAdd };

        operationsPromises.push(
          createMutation({ ...graphqlParams, args: newCreateArgs }, { ...mutationOptions, modelTypeName: association.through ? association.through.name : association.target.name, skipReturning: true, isBulk: true })
        );

      } else {

        recordsToAdd.forEach((record) => {

          const newCreateArgs = {
            [association.target.name]: { ...record, [association.fields[0]]: parentRecord[parentKeys[0]] }
          };

          operationsPromises.push(
            createMutation({ ...graphqlParams, args: newCreateArgs }, { ...mutationOptions, modelTypeName: association.through ? association.through.name : association.target.name, skipReturning: true })
          );
        });

      }

    }

    return Promise.all(operationsPromises);

  }));

}

async function updateMutation (graphqlParams, mutationOptions) {

  const { args, context } = graphqlParams;
  const { isBulk, where, modelTypeName, models, transaction, skipReturning } = mutationOptions;
  const model = models[modelTypeName];
  const { returning } = Array.isArray(model.graphql.bulk) ? {} : model.graphql.bulk;
  const input = args[modelTypeName];

  if (isBulk) {
    const keys = model.primaryKeyAttributes;
    const updatePromises = [];
    const findWhere = {};

    input.forEach((record) => {

      const where = keys.reduce((all, key) => {

        findWhere[key] = findWhere[key] || [];
        findWhere[key].push(record[key]);
        all[key] = record[key];

        return all;
      }, {});

      const newArgs = { [modelTypeName]: record };

      updatePromises.push(
        updateMutation({ ...graphqlParams, args: newArgs }, { ...mutationOptions, where, isBulk: false })
      );

    });

    await Promise.all(updatePromises);

    if (!returning || skipReturning) {
      return input.length;
    }

    return model.findAll({ where: findWhere, transaction });

  }

  // see if a scope is specified to be applied to find queries.
  const variablePath = { args, context };
  const scope = Array.isArray(model.graphql.scopes) ? { method: [model.graphql.scopes[0], _.get(variablePath, model.graphql.scopes[1], model.graphql.scopes[2] || null)] } : model.graphql.scopes;

  await model.scope(scope).update(input, { where, transaction });
  await recursiveUpdateAssociations({ ...graphqlParams }, { ...mutationOptions }, { input, parentRecord: input, parentModel: model });

  if (skipReturning) {
    return;
  }

  return model.findOne({ where, transaction });

}

module.exports = updateMutation;