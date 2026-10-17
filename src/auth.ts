import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Config } from './config.ts';

export class AccessAuth {
  private jwks:ReturnType<typeof createRemoteJWKSet>|undefined;
  private config:Config;
  constructor(config:Config){
    this.config=config;
    if(config.teamDomain.startsWith('https://')) this.jwks=createRemoteJWKSet(new URL(config.teamDomain+'/cdn-cgi/access/certs'));
  }
  async verify(jwt:string|undefined,audience:string):Promise<string>{
    if(!this.jwks||!audience||this.config.emails.size===0)throw Error('Access JWT verification not configured');
    if(!jwt)throw Error('Missing Cloudflare Access JWT');
    const {payload}=await jwtVerify(jwt,this.jwks,{issuer:this.config.teamDomain,audience,algorithms:['RS256']});
    const email=String(payload.email||'').toLowerCase();
    if(!this.config.emails.has(email))throw Error('Email is not permitted');
    return email;
  }
}
