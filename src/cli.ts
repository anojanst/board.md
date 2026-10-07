#!/usr/bin/env node
// boardmd: a local web board for markdown task files.
import { main } from './main.js';

process.exitCode = await main(process.argv.slice(2));
