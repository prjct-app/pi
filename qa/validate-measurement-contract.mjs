#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateMeasurementContract } from './measurement-contract.mjs';

const path = resolve(process.argv[2] ?? 'qa/measurement-contract.json');
const contract = JSON.parse(await readFile(path, 'utf8'));
const summary = validateMeasurementContract(contract);
process.stdout.write(`${JSON.stringify({ status: 'ok', contractId: contract.contractId, ...summary })}\n`);
