import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

type Finding={file:string;category:string};
const assignments:Record<string,{category:string;placeholders:string[]}>= {
  DELTA_LIVE_API_KEY:{category:'DELTA_LIVE_API_KEY',placeholders:['your_live_api_key']},
  DELTA_LIVE_API_SECRET:{category:'DELTA_LIVE_API_SECRET',placeholders:['your_live_api_secret']},
  DELTA_DEMO_API_KEY:{category:'DELTA_DEMO_API_KEY',placeholders:['your_demo_api_key']},
  DELTA_DEMO_API_SECRET:{category:'DELTA_DEMO_API_SECRET',placeholders:['your_demo_api_secret']},
  MONGODB_URI:{category:'MONGODB_CREDENTIAL_URI',placeholders:['your_mongodb_connection_string']},
  AUTH_TEST_MONGODB_URI:{category:'MONGODB_CREDENTIAL_URI',placeholders:['your_disposable_test_mongodb_connection_string']},
  TRADE_TEST_MONGODB_URI:{category:'MONGODB_CREDENTIAL_URI',placeholders:['your_disposable_test_mongodb_connection_string']},
  AUTH_SECRET:{category:'AUTH_SECRET',placeholders:['generate_a_secure_random_secret']},
  INITIAL_ADMIN_PASSWORD:{category:'ADMIN_PASSWORD',placeholders:['set_a_temporary_admin_password']}
};

export function scanTrackedFiles(files:string[]){
  const findings:Finding[]=[];
  for(const file of files){
    let text:string;try{text=fs.readFileSync(file,'utf8')}catch{continue;}
    const categories=new Set<string>();
    for(const line of text.split(/\r?\n/)){
      const match=line.match(/^[+\- ]?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if(match&&assignments[match[1]]&&!assignments[match[1]].placeholders.includes(match[2]))categories.add(assignments[match[1]].category);
    }
    if(/mongodb(?:\+srv)?:\/\/[^\s:@/]+:[^\s@/]+@/i.test(text))categories.add('MONGODB_CREDENTIAL_URI');
    for(const category of categories)findings.push({file,category});
  }
  return findings;
}

if(import.meta.url===`file://${process.argv[1]}`){
  const files=execFileSync('git',['ls-files','-z']).toString().split('\0').filter(Boolean);
  const findings=scanTrackedFiles(files);
  for(const finding of findings)console.error(`${finding.file}\t${finding.category}`);
  if(findings.length)process.exitCode=1;else console.log('Tracked-file secret scan: clean');
}
