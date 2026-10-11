Milestone 5 package

This package contains complete replacement files plus new files for the Grade Wallet Ledger project. It does not contain .env, credentials, node_modules, or any database contents.

1. In PowerShell, copy the package into the project:

$source = 'C:\Users\shubh\Documents\Codex\2026-10-10\referenced-chatgpt-conversation-this-is-an\outputs\milestone5-package'
$project = 'D:\Github\Grade-Wallet-Ledger'
Copy-Item -Path "$source\*" -Destination $project -Recurse -Force

2. Verify the test database target without printing its connection string:

node -r dotenv/config -e "const {Pool}=require('pg'); const p=new Pool({connectionString:process.env.DATABASE_URL}); p.query('SELECT current_database() AS name').then(async r=>{console.log(r.rows[0].name); await p.end()}).catch(async e=>{console.error(e.message); await p.end(); process.exitCode=1})"

Continue only if it prints wallet_test_db. If it prints another database, stop and correct the local configuration without sharing .env contents.

3. Apply the forward migration:

npm.cmd run migrate

4. Run the focused and full test suites:

npm.cmd test -- --runInBand test/milestone5.statement-qa.test.js
npm.cmd test -- --runInBand

The amount and velocity defaults are examples approved for this milestone: ₹10,000 (1,000,000 paise), and five outgoing transfers within 60 seconds. They are stored in risk_rules and can be changed there. No migrations or database commands were run while preparing this package.
