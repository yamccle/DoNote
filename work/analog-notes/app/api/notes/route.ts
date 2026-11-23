import { getDb } from '../../../db';
import { notes } from '../../../db/schema';
import { eq, and } from 'drizzle-orm';
export const dynamic = 'force-dynamic';
const reply = (data: unknown, status=200) => Response.json(data, {status, headers:{'Cache-Control':'no-store'}});
function authorized(request: Request) {const origin=request.headers.get('origin');return !origin||origin===new URL(request.url).origin;}
export async function GET(request: Request) {
 const owner=request.headers.get('oai-authenticated-user-id'); if(!owner) return reply({error:'请先登录以读取云端记录。'},401);
 const rows=await getDb().select().from(notes).where(eq(notes.owner,owner));return reply(rows.map(row=>JSON.parse(row.payload)));
}
export async function POST(request: Request) {
 const owner=request.headers.get('oai-authenticated-user-id'); if(!owner) return reply({error:'请先登录。'},401);
 if(!authorized(request)) return reply({error:'来源无效。'},403);
 const raw=await request.text(); if(raw.length>200000) return reply({error:'记录内容过长。'},413);
 let input; try{input=JSON.parse(raw)}catch{return reply({error:'数据格式错误。'},400)}
 if(!input || typeof input.title!=='string' || !input.title.trim() || input.title.length>240 || !['paper','issue','journal'].includes(input.type) || typeof input.body!=='string' || !['待读','在读','已读','待排查','进行中','已解决','已记录'].includes(input.status) || !Array.isArray(input.tags) || input.tags.some((v:unknown)=>typeof v!=='string') || input.tags.length>30 || !/^\d{4}-\d{2}-\d{2}$/.test(input.date) || (input.url && (typeof input.url!=='string' || !/^https?:\/\//i.test(input.url))) || (input.id && !/^[a-zA-Z0-9-]{1,80}$/.test(input.id))) return reply({error:'请检查标题、日期、链接和正文格式。'},400);
 const id=input.id||crypto.randomUUID();const db=getDb();
 const existing=await db.select().from(notes).where(eq(notes.id,id));if(existing.length&&existing[0].owner!==owner) return reply({error:'无权修改此记录。'},403);
 const record={id,title:input.title.trim(),type:input.type,body:input.body,date:input.date,tags:input.tags,status:input.status,url:input.url||'',reference:typeof input.reference==='string'?input.reference:'',pinned:!!input.pinned,updatedAt:new Date().toISOString()};
 await db.insert(notes).values({id,owner,payload:JSON.stringify(record),updatedAt:record.updatedAt}).onConflictDoUpdate({target:notes.id,set:{payload:JSON.stringify(record),updatedAt:record.updatedAt}});return reply(record);
}
export async function DELETE(request: Request) {
 const owner=request.headers.get('oai-authenticated-user-id');if(!owner) return reply({error:'请先登录。'},401);
 if(!authorized(request)) return reply({error:'来源无效。'},403);
 const id=new URL(request.url).searchParams.get('id');if(!id) return reply({error:'缺少记录编号。'},400);
 await getDb().delete(notes).where(and(eq(notes.id,id),eq(notes.owner,owner)));return reply({ok:true});
}
