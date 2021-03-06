import Knex from 'knex';

import DynamoDbSearchQueue from '@cumulus/aws-client/DynamoDbSearchQueue';
import * as KMS from '@cumulus/aws-client/KMS';
import { envUtils, keyPairProvider } from '@cumulus/common';
import Logger from '@cumulus/logger';

import { RecordAlreadyMigrated } from './errors';
import { MigrationSummary } from './types';

const Manager = require('@cumulus/api/models/base');
const schemas = require('@cumulus/api/models/schemas');

const logger = new Logger({ sender: '@cumulus/data-migration/providers' });

export interface RDSProviderRecord {
  name: string
  protocol: string
  host: string
  port?: number
  username?: string
  password?: string
  globalConnectionLimit?: number
  privateKey?: string
  cmKeyId?: string
  certificateUri?: string
  created_at: Date
  updated_at?: Date
}

const decrypt = async (value: string): Promise<string> => {
  try {
    const plaintext = await KMS.decryptBase64String(value);

    if (plaintext === undefined) {
      throw new Error('Unable to decrypt');
    }

    return plaintext;
  } catch (error) {
    return keyPairProvider.S3KeyPairProvider.decrypt(value);
  }
};

/**
 * Migrate provider record from Dynamo to RDS.
 *
 * @param {AWS.DynamoDB.DocumentClient.AttributeMap} dynamoRecord
 *   Source record from DynamoDB
 * @param {string} providerKmsKeyId - KMS key ID for encrypting provider credentials
 * @param {Knex} knex - Knex client for writing to RDS database
 * @returns {Promise<number>} - Cumulus ID for record
 * @throws {RecordAlreadyMigrated}
 *   if record was already migrated
 */
export const migrateProviderRecord = async (
  dynamoRecord: AWS.DynamoDB.DocumentClient.AttributeMap,
  providerKmsKeyId: string,
  knex: Knex
): Promise<void> => {
  // Use API model schema to validate record before processing
  Manager.recordIsValid(dynamoRecord, schemas.provider);

  const existingRecord = await knex<RDSProviderRecord>('providers')
    .where('name', dynamoRecord.id)
    .first();
  // Throw error if it was already migrated.
  if (existingRecord) {
    throw new RecordAlreadyMigrated(`Provider name ${dynamoRecord.id} was already migrated, skipping`);
  }

  let { username, password } = dynamoRecord;
  const { encrypted } = dynamoRecord;

  if (username) {
    const plaintext = encrypted ? await decrypt(username) : username;
    username = await KMS.encrypt(providerKmsKeyId, plaintext);
  }

  if (password) {
    const plaintext = encrypted ? await decrypt(password) : password;
    password = await KMS.encrypt(providerKmsKeyId, plaintext);
  }

  // Map old record to new schema.
  const updatedRecord: RDSProviderRecord = {
    name: dynamoRecord.id,
    protocol: dynamoRecord.protocol,
    host: dynamoRecord.host,
    port: dynamoRecord.port,
    username,
    password,
    globalConnectionLimit: dynamoRecord.globalConnectionLimit,
    privateKey: dynamoRecord.privateKey,
    cmKeyId: dynamoRecord.cmKeyId,
    certificateUri: dynamoRecord.certificateUri,
    created_at: new Date(dynamoRecord.createdAt),
    updated_at: dynamoRecord.updatedAt ? new Date(dynamoRecord.updatedAt) : undefined,
  };

  await knex('providers').insert(updatedRecord);
};

export const migrateProviders = async (
  env: NodeJS.ProcessEnv,
  knex: Knex
): Promise<MigrationSummary> => {
  const providersTable = envUtils.getRequiredEnvVar('ProvidersTable', env);
  const providerKmsKeyId = envUtils.getRequiredEnvVar('provider_kms_key_id', env);

  const searchQueue = new DynamoDbSearchQueue({
    TableName: providersTable,
  });

  const migrationSummary = {
    dynamoRecords: 0,
    success: 0,
    failed: 0,
    skipped: 0,
  };

  let record = await searchQueue.peek();
  /* eslint-disable no-await-in-loop */
  while (record) {
    migrationSummary.dynamoRecords += 1;

    try {
      await migrateProviderRecord(record, providerKmsKeyId, knex);
      migrationSummary.success += 1;
    } catch (error) {
      if (error instanceof RecordAlreadyMigrated) {
        migrationSummary.skipped += 1;
        logger.info(error);
      } else {
        migrationSummary.failed += 1;
        logger.error(
          `Could not create provider record in RDS for Dynamo provider name ${record.id}:`,
          error
        );
      }
    }

    await searchQueue.shift();
    record = await searchQueue.peek();
  }
  /* eslint-enable no-await-in-loop */
  logger.info(`successfully migrated ${migrationSummary.success} provider records`);
  return migrationSummary;
};
