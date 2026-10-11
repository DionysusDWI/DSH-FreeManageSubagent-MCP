import fs from 'node:fs';
import path from 'node:path';
import {reserveAcceptance} from '../../lib/acceptance.js';
try {const request=JSON.parse(process.argv[3]);const receipt=reserveAcceptance(process.argv[2],request);process.stdout.write(JSON.stringify({accepted:true,caseId:receipt.caseId}));}
catch(error){process.stdout.write(JSON.stringify({accepted:false,code:error.code,message:error.message}));}
