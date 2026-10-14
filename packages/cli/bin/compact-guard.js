#!/usr/bin/env node
import { main } from '../dist/run.js';

// exitCode instead of exit() so buffered stdout is flushed before the process ends.
process.exitCode = await main(process.argv.slice(2));
