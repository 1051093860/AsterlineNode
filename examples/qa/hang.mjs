// QA-only fixture. Never access host files or network: idle long enough to time out.
export async function run(){
  await new Promise(resolve=>setTimeout(resolve,30000));
  return {unexpected:'timeout failed'};
}
