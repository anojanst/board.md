#!/usr/bin/env node
// boardmd: a local web board for markdown task files. See HANDOVER.md for the plan.
import { main } from './main.js';

process.exitCode = main(process.argv.slice(2));
