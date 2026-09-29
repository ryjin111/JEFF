import { readFile } from 'node:fs/promises';
import process from 'node:process';

import { assessJeffLiveShadowSoak } from '../api/_lib/jeff-live-shadow-soak.mjs';

const reportPath = process.argv[2];
if (!reportPath) throw new Error('JEFF_LIVE_SHADOW_REPORT_PATH_REQUIRED');

const report = JSON.parse(await readFile(reportPath, 'utf8'));
const assessment = assessJeffLiveShadowSoak(report);
process.stdout.write(`${JSON.stringify(assessment, null, 2)}\n`);
if (!assessment.eligible) process.exitCode = 1;
