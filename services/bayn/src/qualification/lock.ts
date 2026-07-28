import { pipe, Result, Schema } from 'effect'

import { strictParseOptions } from '../schemas'
import type { QualificationConstructionFailure } from './failure'
import { hashQualificationMaterial } from './hashing'
import {
  QualificationLockMaterialSchema,
  QualificationLockSchema,
  type QualificationLock,
  type QualificationLockMaterial,
} from './model'

const decodeQualificationLockMaterial = Schema.decodeUnknownResult(QualificationLockMaterialSchema, strictParseOptions)
const decodeQualificationLock = Schema.decodeUnknownResult(QualificationLockSchema, strictParseOptions)

export const makeQualificationLock = (
  input: QualificationLockMaterial,
): Result.Result<QualificationLock, QualificationConstructionFailure> =>
  pipe(
    decodeQualificationLockMaterial(input),
    Result.mapError(
      (cause): QualificationConstructionFailure => ({
        _tag: 'QualificationSchemaInvalid',
        operation: 'lock-material',
        cause,
      }),
    ),
    Result.flatMap((material) =>
      pipe(
        hashQualificationMaterial('lock-material', material),
        Result.flatMap((lockId) =>
          pipe(
            decodeQualificationLock({ ...material, lockId }),
            Result.mapError(
              (cause): QualificationConstructionFailure => ({
                _tag: 'QualificationSchemaInvalid',
                operation: 'lock',
                cause,
              }),
            ),
          ),
        ),
      ),
    ),
  )
