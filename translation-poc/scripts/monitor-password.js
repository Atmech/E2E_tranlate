// Interactive only: avoid putting the password in shell history or process args.
import readline from 'node:readline';
import { passwordHash } from '../bridge/monitor-auth.js';

if (!process.stdin.isTTY) {
  console.error('Run this command in an interactive terminal.');
  process.exit(1);
}
readline.emitKeypressEvents(process.stdin);
function hiddenInput(prompt) {
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise(resolve => {
    let value = '';
    function onKey(text, key) {
      if (key?.ctrl && key.name === 'c') { process.stdin.setRawMode(false); process.stdout.write('\n'); process.exit(130); }
      if (key?.name === 'return') {
        process.stdin.off('keypress', onKey); process.stdin.setRawMode(false); process.stdin.pause();
        process.stdout.write('\n'); resolve(value);
      } else if (key?.name === 'backspace') value = [...value].slice(0, -1).join('');
      else if (text && !key?.ctrl && !/[\x00-\x1f\x7f]/.test(text)) value += text;
    }
    process.stdin.on('keypress', onKey);
  });
}
try {
  const password = await hiddenInput('New monitor password (14–256 characters, hidden): ');
  const confirm = await hiddenInput('Confirm password: ');
  if (password !== confirm) throw new Error('Passwords do not match.');
  console.log(`MONITOR_PASSWORD_HASH=${await passwordHash(password)}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
