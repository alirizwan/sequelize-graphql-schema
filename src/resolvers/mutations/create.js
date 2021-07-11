const { v4: uuid } = require('uuid');
const { keysWhichAreModelAssociations } = require('../../utils');

async function createMutation (graphqlParams, mutationOptions) {

  /**
   * skipReturning: will be passed when creating associations, in that case we can just skip returning options
   */

  const { args } = graphqlParams;
  const { isBulk, modelTypeName, models, transaction, skipReturning } = mutationOptions;
  const model = models[modelTypeName];
  const { bulkColumn, returning } = Array.isArray(model.graphql.bulk) ? {} : model.graphql.bulk;
  // if a column is provided in the table as bulk identifier, this would be used along with bulkColumn option
  const bulkIdentifier = uuid();
  let input = args[modelTypeName];

  if (isBulk) {

    const individually = returning && !bulkColumn; // create records in separate create calls.

    // When using bulkColumn, we need to populate it with a unique identifier to use it in where for findAll
    if (bulkColumn) {
      input = (args[modelTypeName] || []).map((record) => {

        record[bulkColumn] = bulkIdentifier;

        return record;
      });
    }

    if (!individually || skipReturning) {

      // create records in bulk and return created objects using findall on bulkColumn
      await model.bulkCreate(input, { transaction, validate: true });

      if (returning && bulkColumn) {
        return model.findAll({ where: { [bulkColumn]: bulkIdentifier }, transaction });
      }

    } else {

      // create records individually and return created objects if returning is set to true
      const createdRecords = await Promise.all(
        input.map((record) => model.create(record, { transaction }))
      );

      if (returning) {
        return createdRecords;
      }

    }

    // return length when bulk option is without returning.
    return input.length;

  }

  const createdRecord = await model.create(input, { transaction });

  await recursiveCreateAssociations({ ...graphqlParams }, { ...mutationOptions }, { input, parentRecord: createdRecord, operation: createMutation, parentModel: model });

  return createdRecord;

}

function recursiveCreateAssociations(graphqlParams, mutationOptions, options) {

  const { input, parentRecord, operation, parentModel } = options;
  const { modelTypeName, models } = mutationOptions;
  const model = models[modelTypeName];
  const keys = model.primaryKeyAttributes;
  const parentKeys = parentModel.primaryKeyAttributes;
  const availableAssociations = keysWhichAreModelAssociations(input, model.associations);

  return Promise.all(availableAssociations.map((association) => {

    return Promise.all(input[association.key].map(async (record) => {

      const recordToCreate = { ...record, [association.fields[0]]: parentRecord[parentKeys[0]] };
      let newArgs = { [association.target.name]: recordToCreate };
      let newModelTypeName = association.target.name;

      // association is belongsToMany, we have two cases: 1. Create assocciation record and through record. 2. Association record already exist and only create through record
      if (association.through) {

        const reverseAssociations = association.target.associations;
        const reverseAssociationKeys = Object.keys(reverseAssociations).filter((key) => reverseAssociations[key].target.name === model.name);
        const reverseAssociationForeignKey = reverseAssociations[reverseAssociationKeys[0]].foreignKey;
        const throughRecord = { ...record[association.through.name], [association.fields[0]]: parentRecord[parentKeys[0]] };

        // id is not present, we need to create association record as well as through record.
        if (!record[keys[0]]) {
          const assocciationArgs = { [association.target.name]: { ...record } };
          const associationRecord = await operation({ ...graphqlParams, args: assocciationArgs }, { ...mutationOptions, modelTypeName: association.target.name, skipReturning: true });

          throughRecord[reverseAssociationForeignKey] = associationRecord[keys[0]];
        } else {
          throughRecord[reverseAssociationForeignKey] = record[keys[0]];
        }

        newModelTypeName = association.through.name;
        newArgs = { [association.through.name]: throughRecord };

      }

      // for hasMany simply create association records, if belongsToMany create association through record
      return operation({ ...graphqlParams, args: newArgs }, { ...mutationOptions, modelTypeName: newModelTypeName, skipReturning: true });

    }));

  }));
}

module.exports = createMutation;