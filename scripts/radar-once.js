'use strict';
require('dotenv').config();
const {runRadar}=require('../src/radar/worker');
const db=require('../src/db/pool');
runRadar({dryRun:process.argv.includes('--dry-run')}).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.message);process.exitCode=1;}).finally(()=>db.end());
