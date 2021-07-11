const { GraphQLClient } = require('graphql-request');
const _ = require('lodash');

module.exports = async (options, context) => {

  // eslint-disable-next-line no-unused-vars
  const defaultOptions = {
    endpoint: null,
    queries: [],
    headers: null
  };
  const IgnoreTypes = ['Int', 'SequelizeJSON', 'String', 'Boolean'];
  const introspectionQuery = `query IntrospectionQuery {
      __schema {
        queryType { name }
        mutationType { name }
        subscriptionType { name }
        types {
          ...FullType
        }
        directives {
          name
          description
          locations
          args {
            ...InputValue
          }
        }
      }
    }
    fragment FullType on __Type {
      kind
      name
      description
      fields(includeDeprecated: true) {
        name
        description
        args {
          ...InputValue
        }
        type {
          ...TypeRef
        }
        isDeprecated
        deprecationReason
      }
      inputFields {
        ...InputValue
      }
      interfaces {
        ...TypeRef
      }
      enumValues(includeDeprecated: true) {
        name
        description
        isDeprecated
        deprecationReason
      }
      possibleTypes {
        ...TypeRef
      }
    }
    fragment InputValue on __InputValue {
      name
      description
      type { ...TypeRef }
      defaultValue
    }
    fragment TypeRef on __Type {
      kind
      name
      ofType {
        kind
        name
        ofType {
          kind
          name
          ofType {
            kind
            name
            ofType {
              kind
              name
              ofType {
                kind
                name
                ofType {
                  kind
                  name
                  ofType {
                    kind
                    name
                  }
                }
              }
            }
          }
        }
      }
    }`;

  // eslint-disable-next-line no-unused-vars
  function getTypes(type, AllTypes, array) {

    array = array || [];

    type.fields.forEach((field) => {

      if (options.queries.indexOf(field.name) > -1) {
        QueriesToImport.push(field);

        field.args.forEach((arg) => {
          if (IgnoreTypes.indexOf(arg.type.name || arg.type.ofType.name) == -1) {
            array.push(AllTypes[arg.type.name || arg.type.ofType.name]);
          }
        });

        if (IgnoreTypes.indexOf(field.type.name || field.type.ofType.name) == -1) {
          array.push(AllTypes[field.type.name || field.type.ofType.name]);
        }

      }

    });

    return array;

  }

  const headers = context ? _.pick(context.headers, options.headers) : {};

  headers['graphql-introspection'] = true;

  const client = new GraphQLClient(options.endpoint, { headers });
  const data = await client.request(introspectionQuery);
  const schema = data.__schema;
  const queryTypeName = schema.queryType.name;
  const Types = schema.types;
  const AllTypes = { };
  const QueriesToImport = [];
  const TypesToImport = [];

  for (let index = 0; index < Types.length; index++) {
    AllTypes[Types[index].name] = Types[index];
  }

  const queryType = AllTypes[queryTypeName];

  queryType.fields.forEach((field) => {

    if (options.queries[field.name]) {

      let outputName = null;

      field.args.forEach((arg) => {
        if (IgnoreTypes.indexOf(arg.type.name || arg.type.ofType.name) == -1) {
          const tempType = AllTypes[arg.type.name || arg.type.ofType.name];

          tempType.name = options.queries[field.name].as || tempType.name;
          TypesToImport.push(tempType);
        }
      });

      if (IgnoreTypes.indexOf(field.type.name || field.type.ofType.name) == -1) {
        const tempType = AllTypes[field.type.name || field.type.ofType.name];

        tempType.name = options.queries[field.name].as || tempType.name;
        outputName = tempType.name;
        TypesToImport.push(tempType);
      }

      field.outputName = outputName;
      QueriesToImport.push(field);

    }

  });

  const FilteredTypes = {};
  const FilteredQueries = [];

  TypesToImport.forEach((type) => {

    const obj = {};

    type.fields.forEach((field) => {
      if (field.type.kind == 'SCALAR' || field.type.ofType.kind == 'SCALAR') {
        obj[field.name] = field.type.name || field.type.ofType.name;
      }
    });

    FilteredTypes[type.name] = obj;

  });

  QueriesToImport.forEach((query) => {

    const obj = { args: { }, name: query.name, endpoint: options.endpoint, headers: options.headers, output: query.outputName, isList: query.type.kind === 'LIST', options: options.options };

    query.args.forEach((arg) => {
      obj.args[arg.name] = arg.type.name;

    });

    FilteredQueries.push(obj);

  });

  return { types: FilteredTypes, queries: FilteredQueries };

};
