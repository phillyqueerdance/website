import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
export function sqliteD1(){
  const sql=new DatabaseSync(':memory:');sql.exec(fs.readFileSync(new URL('../../migrations/discovery/0001.sql',import.meta.url),'utf8'));
  const wrap=(query,args=[])=>({bind(...values){return wrap(query,values);},
    async first(){return sql.prepare(query).get(...args)||null;},
    async all(){return {success:true,results:sql.prepare(query).all(...args)};},
    async run(){const result=sql.prepare(query).run(...args);return {success:true,meta:{changes:Number(result.changes)},results:[]};},
    _query:query,_args:args});
  return {prepare:wrap,async batch(statements){sql.exec('BEGIN');try{const out=[];for(const s of statements){const p=sql.prepare(s._query);if(/^\s*SELECT/i.test(s._query))out.push({results:p.all(...s._args),success:true});else{const r=p.run(...s._args);out.push({success:true,results:[],meta:{changes:Number(r.changes)}});}}sql.exec('COMMIT');return out;}catch(error){sql.exec('ROLLBACK');throw error;}},_sql:sql};
}
