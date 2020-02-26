'use strict';

const curry = require('lodash.curry');
const groupBy = require('lodash.groupby');
const isBoolean = require('lodash.isboolean');
const pick = require('lodash.pick');
const Logger = require('@cumulus/logger');
const map = require('lodash.map');
const got = require('got');
const { getAuthToken } = require('@cumulus/common/auth-token');
const { runCumulusTask } = require('@cumulus/cumulus-message-adapter-js');
const { buildProviderClient } = require('@cumulus/ingest/providerClientUtils');
const { normalizeProviderPath } = require('@cumulus/ingest/util');
const { duplicateHandlingType } = require('@cumulus/ingest/granule');
const { getSecretString } = require('@cumulus/aws-client/SecretsManager');


const logger = () => new Logger({
  executions: process.env.EXECUTIONS,
  granules: process.env.GRANULES,
  parentArn: process.env.PARENTARN,
  sender: process.env.SENDER,
  stackName: process.env.STACKNAME,
  version: process.env.TASKVERSION
});


/**
 * Fetch a list of files from the provider
 *
 * @param {Object} providerConfig - the connection config for the provider
 * @param {bool} useList - flag to tell ftp server to use 'LIST' instead of 'STAT'
 * @param {*} path - the provider path to search
 * @returns {Array<Object>} a list of discovered file objects
 */
const listFiles = (providerConfig, useList, path) =>
  buildProviderClient({ ...providerConfig, useList }).list(path);

/**
 * Given a regular expression and a file containing a name, extract the granule
 * id from the file's name
 *
 * @param {RegExp} granuleIdRegex - a regular expression where the first
 * matching group is the granule id
 * @param {Object} file - a file containing a `name` property
 * @returns {string|null} returns the granule id, if one could be extracted,
 * or null otherwise
 */
const granuleIdOfFile = curry(
  (granuleIdRegex, { name }) => {
    const match = name.match(granuleIdRegex);
    return match ? match[1] : null;
  }
);

/**
 * Given a regular expression and a list of files, return an Object where the
 * granule ids are the Object keys and the values are an Array of the files with
 * that granule id.
 *
 * Files where a granule id could not be determined will not be returned
 *
 * @param {RegExp} granuleIdRegex - a regular expression where the first
 * matching group is the granule id
 * @param {Array<Object>} files - a list of files containing a `name` property
 * @returns {Object<Array>} the files, grouped by granule id
 */
const groupFilesByGranuleId = (granuleIdRegex, files) => {
  const result = groupBy(files, granuleIdOfFile(granuleIdRegex));
  delete result.null;
  return result;
};

/**
 * Find the collection file config associated with the file
 *
 * @param {Array<Object>} collectionFileConfigs - a list of collection file
 * configs
 * @param {Object} file - a file
 * @returns {Object|undefined} returns the matching collection file config, or
 * `undefined` if a matching config could not be found
 */
const getCollectionFileConfig = (collectionFileConfigs, file) =>
  collectionFileConfigs.find(({ regex }) => file.name.match(regex));

/**
 * Check to see if a file has an associated collection file config
 *
 * @param {Array<Object>} collectionFileConfigs - a list of collection file
 * configs
 * @param {Object} file - a file
 * @returns {boolean}
 */
const fileHasCollectionFileConfig = curry(
  (collectionFileConfigs, file) =>
    getCollectionFileConfig(collectionFileConfigs, file) !== undefined
);

/**
 * Typically, only files that have a matching collection file config will be
 * returned. If `config.ignoreFilesConfigForDiscovery` or
 * `config.collection.ignoreFilesConfigForDiscovery` are set to true, though,
 * all files will be returned. Defaults to `false`.
 *
 * This function inspects the config to determine if all files should be
 * returned;
 *
 * @param {Object} config - the event config
 * @returns {boolean}
 */
const returnAllFiles = (config) => {
  if (isBoolean(config.ignoreFilesConfigForDiscovery)) {
    return config.ignoreFilesConfigForDiscovery;
  }
  if (isBoolean(config.collection.ignoreFilesConfigForDiscovery)) {
    return config.collection.ignoreFilesConfigForDiscovery;
  }
  return false;
};

/**
 * Given an event config and a file, find the collection file config associated
 * with the file. If one is found, add `bucket`, `url_path`, and `type`
 * properties to the file.
 *
 * @param {Object} config - a config object containing `buckets` and
 * `collection` properties
 * @param {Object} file - a file object
 * @returns {Object} a file object, possibly with three additional properties
 */
const updateFileFromCollectionFileConfig = curry(
  ({ buckets, collection }, file) => {
    const fileConfig = getCollectionFileConfig(collection.files, file);

    if (fileConfig === undefined) return file;

    return {
      ...file,
      bucket: buckets[fileConfig.bucket].name,
      url_path: fileConfig.url_path || collection.url_path || '',
      type: fileConfig.type || ''
    };
  }
);

/**
 * Build a granule to be returned from the Lambda function
 *
 * @param {Object} config - the event config
 * @param {Array<Object>} files - a list of files belonging to the granule
 * @param {string} granuleId - the granule id
 * @returns {Object} a granule
 */
const buildGranule = curry(
  (config, files, granuleId) => {
    let filesToReturn;

    if (returnAllFiles(config)) {
      filesToReturn = files;
    } else {
      filesToReturn = files
        .filter(fileHasCollectionFileConfig(config.collection.files))
        .map(updateFileFromCollectionFileConfig(config));
    }

    return {
      granuleId,
      dataType: config.collection.dataType,
      version: config.collection.version,
      files: filesToReturn
    };
  }
);


/**
 * checks a granuleId against the Granules API to determine if
 * there is a duplicate granule
 *
 * @param {string} granuleId - granuleId to evaluate
 * @param {Object} dupeConfig - configuration object
 * @param {string} baseUrl - archive base URL
 * @returns {string} returns granuleId string if no duplicate found, '' if
 *                   a duplicate is found.  Throws an error on duplicate if
 *                   dupeConfig.duplicateHandling is set to 'error'
 */
const checkDuplicate = async (granuleId, dupeConfig, baseUrl) => {
  const headers = { authorization: `Bearer ${dupeConfig.token}` };
  try {
    await got.get(`${baseUrl}/granules/${granuleId}`, { headers });
  } catch (error) {
    if (error.statusCode === 404 && error.statusMessage === 'Not Found') {
      return granuleId;
    }
    throw error;
  }
  if (dupeConfig.duplicateHandling === 'error') {
    throw new Error(`Duplicate granule found for ${granuleId} with duplicate configuration set to error`);
  }
  return '';
};

/**
 * Filters granule duplicates from a list of granuleIds according to the
 * configuration in duplicateHandling:
 *
 * skip:               Duplicates will be filtered from the list
 * error:              Duplicates encountered will result in a thrown error
 * replace, version:   Duplicates will be ignored
 *
 * @param {Array.string} granuleIds - Array of granuleIds to filter
 * @param {string} duplicateHandling - flag that defines this function's behavior (see description)
 *
 * @returns {Array.string} returns granuleIds parameter with applicable duplciates removed
 */
const filterDuplicates = async (granuleIds, duplicateHandling) => {
  const provider = process.env.oauth_provider;
  const tokenConfig = {
    baseUrl: process.env.archive_api_uri,
    username: process.env.urs_id,
    password: await getSecretString(
      process.env.urs_password_secret_name
    ),
    launchpadPassphrase: await getSecretString(
      process.env.passphraseSecretName
    ),
    launchpadApi: process.env.launchpad_api,
    launchpadCertificate: process.env.launchpad_certificate

  };
  const authToken = await getAuthToken(provider, tokenConfig);
  const dupeConfig = {
    duplicateHandling: duplicateHandling,
    token: authToken
  };

  const keysPromises = granuleIds.map((key) =>
    checkDuplicate(key, dupeConfig, tokenConfig.baseUrl));

  const filteredKeys = await Promise.all(keysPromises);
  return filteredKeys.filter(Boolean);
};

/**
 * Handles duplicates in the filelist according to the duplicateHandling flag:
 *
 * skip:               Duplicates will be filtered from the list
 * error:              Duplicates encountered will result in a thrown error
 * replace, version:   Duplicates will be ignored
 *
 * @param {Object} filesByGranuleId - Object with granuleId for keys with an array of
 *                                    matching files for each
 *
 * @param {string} duplicateHandling - flag that defines this function's behavior (see description)
 *
 * @returns {Object} returns filesByGranuleId with applicable duplciates removed
 */
const handleDuplicates = async (filesByGranuleId, duplicateHandling = 'error') => {
  logger().info(`Running discoverGranules with duplicateHandling set to ${duplicateHandling}`);
  if (['skip', 'error'].includes(duplicateHandling)) {
    // Iterate over granules, remove if exists in dynamo
    // Is this going to be *expensive*
    const filteredKeys = await filterDuplicates(Object.keys(filesByGranuleId), duplicateHandling);
    return pick(filesByGranuleId, filteredKeys);
  }
  if (['replace', 'version'].includes(duplicateHandling)) {
    return filesByGranuleId;
  }
  throw new Error(`Invalid duplicate handling configuration encountered: ${JSON.stringify(duplicateHandling)}`);
};

/**
 * Discovers granules. See schemas/input.json and schemas/config.json for
 * detailed event description.
 *
 * @param {Object} event - Lambda event object
 * @returns {Object} - see schemas/output.json for detailed output schema that
 *    is passed to the next task in the workflow
 */
const discoverGranules = async ({ config }) => {
  const discoveredFiles = await listFiles(
    config.provider,
    config.useList,
    normalizeProviderPath(config.collection.provider_path)
  );

  let filesByGranuleId = groupFilesByGranuleId(
    config.collection.granuleIdExtraction,
    discoveredFiles
  );

  const duplicateHandling = duplicateHandlingType({ config });
  filesByGranuleId = await handleDuplicates(filesByGranuleId, duplicateHandling);

  const granules = map(filesByGranuleId, buildGranule(config));

  logger().info(`Discovered ${granules.length} granules.`);
  return { granules };
};

/**
 * Lambda handler.
 *
 * @param {Object} event - a Cumulus Message
 * @param {Object} context - an AWS Lambda context
 * @param {Function} callback - an AWS Lambda handler
 * @returns {undefined} - does not return a value
 */
const handler = (event, context, callback) => {
  runCumulusTask(discoverGranules, event, context, callback);
};

module.exports = {
  discoverGranules,
  handler
};
