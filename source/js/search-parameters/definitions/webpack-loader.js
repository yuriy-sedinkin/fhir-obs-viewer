/**
 * Webpack loader for "definitions/index.json".
 * This loader fills result object with data from "search-parameters.json" from https://www.hl7.org/fhir/downloads.html
 * Also uses "profiles-types.json", "profiles-resources.json", "valuesets.json" and "v3-codesystems.json" from the same directory.
 */
const { getOptions }  = require('loader-utils');
const fs = require('fs');

/**
 * Extracts search parameter description for specified resource type from a description of the search parameter
 * @param {string} resourceType
 * @param {string} description
 * @return {string}
 */
function getDescription(resourceType, description) {
  const descriptions = description.split('\r\n')
  const reDescription = new RegExp(`\\[${resourceType}][^:]*:\\s*(.*)`);
  let result = descriptions[0];
  if (descriptions.length > 1) {
    for (let i = 0; i < descriptions.length; ++i) {
      if(reDescription.test(descriptions[i])) {
        result = RegExp.$1;
        break;
      }
    }
  }
  return result.trim();
}

/**
 * Extract search parameters configuration from JSON FHIR Definitions (part of FHIR specification)
 * @param {string} directoryPath - directory where JSON files are located
 * @param {Array<string>} resourceTypes - list of resource types for which you want to get search parameters configuration
 * @param {Array<string>} additionalExpressions - list of additional expressions to extract value sets
 * @return {{}}
 */
function getSearchParametersConfig(directoryPath, resourceTypes, additionalExpressions) {
  const profiles = {
    parameters: JSON.parse(fs.readFileSync(directoryPath + '/search-parameters.json').toString()),
    resources: JSON.parse(fs.readFileSync(directoryPath + '/profiles-resources.json').toString()),
    types:  JSON.parse(fs.readFileSync(directoryPath + '/profiles-types.json').toString()),
    valueSets:  JSON.parse(fs.readFileSync(directoryPath + '/valuesets.json').toString()),
    v3CodeSystems:  JSON.parse(fs.readFileSync(directoryPath + '/v3-codesystems.json').toString())
  };

  /**
   * @typedef TypeDescriptionHash
   * @type {Object}
   * @property {string} type - type name
   * @property {string} [path] - path in which this type was found, if available
   * @property {Object} [typeDescription] - full type description object useful for debugging
   * @property {string} [valueSet] - value set url
   */

  /**
   * Finds type by expression
   * @param {string} expression
   * @return {TypeDescriptionHash}
   */
  function getTypeByExpression(expression) {
    // only one expression at this moment has substring ".exists()"
    if (expression.indexOf('.exists()') !== -1) {
      return {type: 'boolean'};
    }

    // we can't parse expressions with "where" now; therefore, we will treat them as having a string type
    if (expression.indexOf('.where(') !== -1) {
      return {type: 'string'};
    }

    const path = expression.split(' ')[0];
    return { path, ...getTypeByPath(path.split('.')) };
  }

  /**
   * Finds a type of resource property by the property path
   * @param {string} resourceType
   * @param {Array<string>} path
   * @return {TypeDescriptionHash}
   */
  function getTypeByPath([resourceType, ...path]) {
    if (!path.length) {
      return {
        type: resourceType
      };
    }
    const entry = profiles.resources.entry.find(i => i.resource.id === resourceType)
      || profiles.types.entry.find(i => i.resource.id === resourceType);
    const resource = entry.resource;
    const expression = resourceType + '.' + path[0];
    const desc = resource.snapshot.element.filter(i => i.id === expression)[0] || resource.snapshot.element.filter(i => i.id.indexOf(expression) === 0)[0];
    const type = desc.type[0].code;
    if (path.length === 1) {
      return {
        type,
        typeDescription: desc.type,
        ...(desc.binding && desc.binding.valueSet ? {valueSet: desc.binding.valueSet} : {})
      };
    } else if (type === 'BackboneElement') {
      return getTypeByPath([resourceType, path[0]+'.'+path[1], ...path.slice(2)]);
    } else {
      return getTypeByPath([desc.type[0].code, ...path.slice(1)]);
    }
  }

  /**
   * Gets ValueSet items with filtering by includeCodes if specified and converting a tree of concepts to the flat list, if includeChildren is true
   * @param {Array<{code: string, display: string}>} concept - concept input array, each concept can have a nested concept array
   * @param {Array<string> | null} includeCodes - if specified, then a list of concept codes that we should include
   *                                            in the result array
   * @param {boolean} includeChildren - true if we should include nested concepts in the result Array
   * @return {Array<{code: string, display: string}>}
   */
  function getValueSetItems(concept, includeCodes, includeChildren) {
    if (includeCodes) {
      return concept.reduce((acc, i) => {
        if(includeCodes[i.code]) {
          acc.push({
            code: i.code,
            display: i.display
          });
        }

        return i.concept ? acc.concat(getValueSetItems(i.concept, includeChildren && includeCodes[i.code] ? null : includeCodes, includeChildren)) : acc;
      }, []);
    }

    return concept.reduce((acc, i) => {
      acc.push({
        code: i.code,
        display: i.display
      });
      // TODO: i.concept ??
      return i.concept ? acc.concat(getValueSetItems(i.concept, null, includeChildren)) : acc;
    }, []);
  }

  /**
   * Gets ValueSet by URL.
   * If it was not possible to get an array of items for ValueSet, then a string with a URL is returned.
   * @param {{url:string}|...} options
   * @return {Array<{code: string, display: string}> | string}
   */
  function getValueSet(options) {
    const url = (options.url || options.system).split('|')[0];
    const entry = (profiles.valueSets.entry.find(i => i.fullUrl === url || i.resource.url === url) || profiles.v3CodeSystems.entry.find(i => i.fullUrl === url || i.resource.url === url));
    if (!entry) {
      if (options.concept) {
        return options.concept.map(options => ({
          code: options.code,
          display: options.display
        }));
      }
      return null;
    }
    const desc = entry.resource;
    let result = [];


    if (desc && desc.concept) {
      const includeCodes = options.concept && options.concept.reduce((acc, c) => {
          acc[c.code] = true;
          return acc;
        }, {});
      const filterCodes = options.filter && options.filter.reduce((acc, f) => {
          if (f.property !== 'concept' || f.op !== 'is-a' || !f.value) {
            // TODO: support full include specification? (see http://hl7.org/fhir/valueset.html)
            console.error('Unsupported filter value:', options);
          } else {
            acc[f.value] = true;
          }
          return acc;
        }, {});
      result = result.concat(getValueSetItems(desc.concept, includeCodes || filterCodes, !!filterCodes));
    }

    const compose = desc && desc.compose;
    const include = compose && compose.include;
    if (include) {
      result = result.concat(...include.map(i => {
        const valueSet = getValueSet(i);
        if (!valueSet) {
          console.log('Can\'t find:', i);
        } else if (!(valueSet instanceof Array)) {
          console.log('No values for:', valueSet);
        }

        const exclude = compose.exclude && compose.exclude.find(e => e.system === i.system);
        if(exclude && !exclude.concept) {
          // TODO: support full exclude specification? (see http://hl7.org/fhir/valueset.html)
          console.error('Unsupported exclude value:', options);
        }
        const excludeCodes = exclude && exclude.concept && exclude.concept.reduce((acc, e) => ({...acc, [e.code]: true}), {});

        return valueSet instanceof Array && excludeCodes ? valueSet.filter(j => !excludeCodes[j.code]) : valueSet;
      }).filter(i => i instanceof Array));
    }

    return result.length ? result : url;
  }

  let result = {
    resources: {},
    valueSets: {},
    // to avoid duplication of objects in memory, the properties below are filled at runtime,
    // see method getCurrentDefinitions (common-descriptions.js) for details
    valueSetByPath: {},
    valueSetMaps: {},
    valueSetMapByPath: {},
  };

  resourceTypes.forEach(resourceType => {
    result.resources[resourceType] = profiles.parameters.entry
      .filter(item => item.resource.base.indexOf(resourceType) !== -1)
      .map(item => {
        new RegExp(`(${resourceType}\.[^|]*)( as ([^\\s)]*)|)`).test(item.resource.expression);
        const param = {
          name: item.resource.name,
          type: RegExp.$3 && RegExp.$3.trim() || item.resource.type,
          expression: RegExp.$1.trim(),
          description: item.resource.base.length > 1
            ? getDescription(resourceType, item.resource.description)
            : item.resource.description.trim()
        };
        if (param.type === 'token') {
          Object.assign(param, getTypeByExpression(param.expression));
        }
        if (param.valueSet && !result.valueSets[param.valueSet])  {
          const valueSet = getValueSet({ url: param.valueSet });
          result.valueSetByPath[param.path] = param.valueSet;
          result.valueSets[param.valueSet] = valueSet instanceof Array
            ? valueSet.sort((a,b) => a.display.localeCompare(b.display))
            : valueSet;
        }
        return param;
      });
  });


  // Find value sets for additional expressions
  additionalExpressions.forEach(expression => {
    const param = getTypeByExpression(expression);
    if (param.valueSet && !result.valueSets[param.valueSet])  {
      const valueSet = getValueSet({ url: param.valueSet });
      result.valueSetByPath[param.path] = param.valueSet;
      result.valueSets[param.valueSet] = valueSet instanceof Array
        ? valueSet.sort((a,b) => a.display.localeCompare(b.display))
        : valueSet;
    }
  });

  return result;
}

module.exports = function loader(source) {
  const index = JSON.parse(source);
  const { resourceTypes, additionalExpressions } = getOptions(this);

  index.configByVersionName = Object.values(index.versionNameByNumber).reduce((acc,versionName) => {
    if (!acc[versionName]) {
      acc[versionName] = getSearchParametersConfig(this.context + '/' + versionName, resourceTypes, additionalExpressions);
    }
    return acc;
  }, {})

  return JSON.stringify(index);
}