'use strict';

const WEB_CAPTURE_MAX_HTML=100*1024*1024;
const WEB_CAPTURE_IMAGE=/^data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/=]{1,327680}$/i;
const WEB_CAPTURE_TAGS=new Set(('a abbr address article aside b bdi bdo blockquote br caption cite code col colgroup dd del details dfn div dl dt em figcaption figure footer h1 h2 h3 h4 h5 h6 header hgroup hr i img ins kbd li main mark menu nav ol p pre q rp rt ruby s samp section small span strong sub summary sup table tbody td tfoot th thead time tr u ul var wbr').split(' '));
const WEB_CAPTURE_DROP=new Set('audio canvas embed frame frameset iframe input link meta noscript object option script select source style template textarea title track video'.split(' '));

function webCaptureUrl(value,base){
 try{
  const url=new URL(value,base);
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password)return null;
  return url;
 }catch{return null}
}
function captureTemplate(html){
 const template=document.createElement('template');
 template.innerHTML=html;
 return template;
}
function inlineCaptureCss(styles){
 return styles.slice(0,15).join('\n').slice(0,300000).replaceAll('<','\\3c ');
}

function sanitizeCaptureFragment(fragment,{base,assets={},snapshot=false,forParser=false}={}){
 for(const node of fragment.querySelectorAll('*')){
  if(!fragment.contains(node))continue;
  const tag=node.localName;
  if(node.namespaceURI!=='http://www.w3.org/1999/xhtml'||WEB_CAPTURE_DROP.has(tag)){
   node.remove();continue;
  }
  if(!WEB_CAPTURE_TAGS.has(tag)){
   node.replaceWith(...node.childNodes);continue;
  }
  const originalHref=node.getAttribute('href')||'';
  const src=tag==='img'?imageCaptureSource(node,base):'';
  for(const {name,value} of [...node.attributes]){
   const common=['alt','title','lang','dir'].includes(name);
   const layout=(tag==='td'||tag==='th')&&['colspan','rowspan'].includes(name)&&/^\d{1,3}$/.test(value);
   const dimensions=tag==='img'&&['width','height'].includes(name)&&/^\d{1,4}$/.test(value);
   const classes=(snapshot||forParser)&&['class','id'].includes(name);
   const styling=snapshot&&name==='style';
   if(!(common||layout||dimensions||classes||styling))node.removeAttribute(name);
  }
  if(tag==='a'){
   if(originalHref.startsWith('#')&&snapshot)node.setAttribute('href',originalHref);
   if(!snapshot){
    const href=webCaptureUrl(originalHref,base);
    if(originalHref&&href){
     node.setAttribute('href',href.href);node.setAttribute('target','_blank');node.setAttribute('rel','noopener noreferrer');
    }
   }
  }
  if(tag==='img'){
   const data=WEB_CAPTURE_IMAGE.test(src)?src:assets[src];
   if(typeof data==='string'&&WEB_CAPTURE_IMAGE.test(data)){
    node.setAttribute('src',data);node.setAttribute('loading','lazy');
   }else{
    const alt=node.getAttribute('alt')?.trim();
    if(alt)node.replaceWith(document.createTextNode('［'+alt+'］'));else node.remove();
   }
  }
 }
}
function imageCaptureSource(node,base){
 const raw=node.getAttribute('data-src')||node.getAttribute('data-original')||node.getAttribute('src')||
  (node.getAttribute('srcset')||'').trim().split(/\s|,/)[0];
 if(!raw)return '';
 if(WEB_CAPTURE_IMAGE.test(raw))return raw;
 const url=webCaptureUrl(raw,base);if(!url)return '';
 url.hash='';return url.href;
}
function captureStyles(fragment){
 return [...fragment.querySelectorAll('style')].slice(0,12).map(style=>style.textContent);
}
function snapshotDocument(template,styles,title='网页快照'){
 const policy="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
 return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="'+policy+'"><title>'+esc(title)+'</title><style>body{margin:16px;overflow-wrap:anywhere}img{max-width:100%;height:auto}'+inlineCaptureCss(styles)+'</style></head><body>'+template.innerHTML+'</body></html>';
}
function safeCapturedHtml(html,{snapshot=false}={}){
 const value=String(html||'');
 if(value.length>20*1024*1024)throw new Error('保存的网页内容超过可读取范围。');
 const template=captureTemplate(value);
 const styles=snapshot?captureStyles(template.content):[];
 sanitizeCaptureFragment(template.content,{snapshot});
 return snapshot?snapshotDocument(template,styles):template.innerHTML;
}

const pendingWebCaptures=new Map();
const webCaptureBridge=location.origin==='https://yams-one.example'?window.chrome?.webview:null;
webCaptureBridge?.addEventListener('message',event=>{
 const message=event.data;
 if(message?.type!=='yams-one-web-capture')return;
 const pending=pendingWebCaptures.get(message.id);
 if(!pending)return;
 clearTimeout(pending.timer);pendingWebCaptures.delete(message.id);
 if(message.error)pending.reject(new Error(message.error));else pending.resolve(message);
});
function fetchCaptureData(fields){
 if(!webCaptureBridge)return Promise.reject(new Error('请在 DoNote Windows 桌面版使用网页收藏。'));
 const id=crypto.randomUUID();
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{pendingWebCaptures.delete(id);reject(new Error('网页读取超时，请重试。'))},28000);
  pendingWebCaptures.set(id,{resolve,reject,timer});
  try{webCaptureBridge.postMessage({type:'capture-web-article',id,...fields})}
  catch(error){clearTimeout(timer);pendingWebCaptures.delete(id);reject(error)}
 });
}
function collectCaptureAssets(template,base){
 const assets=[],seen=new Set();
 function add(url,kind){
  if(!url||url.length>2048||url.startsWith('data:')||seen.has(url))return false;
  seen.add(url);assets.push({url,kind});return true;
 }
 let count=0,unselectedImages=0;
 const imageUrls=new Set();
 for(const image of new Set([...template.content.querySelectorAll('#js_content img,main img,article img'),...template.content.querySelectorAll('img')])){
  const url=imageCaptureSource(image,base);
  if(!url||url.length>2048||url.startsWith('data:')||imageUrls.has(url))continue;
  imageUrls.add(url);
  if(count<24){if(add(url,'image'))count++}else unselectedImages++;
 }
 assets.unselectedImages=unselectedImages;
 count=0;
 for(const link of template.content.querySelectorAll('link[rel~="stylesheet"]')){
  if(add(webCaptureUrl(link.getAttribute('href')||'',base)?.href,'style')&&++count===3)break;
 }
 return assets;
}

async function parseCapturedWebArticle(url,html,{cacheAssets=false}={}){
 const page=webCaptureUrl(url);
 if(!page||typeof html!=='string'||html.length>WEB_CAPTURE_MAX_HTML)throw new Error('网页内容无效或超出收藏大小。');
 const original=captureTemplate(html);
 const meta=name=>[...original.content.querySelectorAll('meta[name],meta[property]')].find(node=>
  (node.getAttribute('property')||node.getAttribute('name'))?.toLowerCase()===name)?.getAttribute('content')?.trim()||'';
 const fallbackTitle=meta('og:title')||original.content.querySelector('title')?.textContent.trim()||
  original.content.querySelector('h1')?.textContent.trim()||page.hostname;
 const fallbackByline=meta('author')||meta('article:author');
 const fallbackExcerpt=meta('description')||meta('og:description');
 const styles=captureStyles(original.content);
 const requested=cacheAssets?collectCaptureAssets(original,page.href):[];
 let assets={};
 if(requested.length){
  try{assets=(await fetchCaptureData({kind:'assets',assets:requested})).assets||{}}
  catch{}
 }
 const linkedStyles=requested.filter(asset=>asset.kind==='style').map(asset=>assets[asset.url]).filter(value=>typeof value==='string');
 const parserInput=captureTemplate(html);
 sanitizeCaptureFragment(parserInput.content,{base:page.href,assets,forParser:true});
 const doc=document.implementation.createHTMLDocument(fallbackTitle);
 doc.body.append(parserInput.content.cloneNode(true));
 let article;
 try{article=new Readability(doc,{charThreshold:180,maxElemsToParse:16000}).parse()}catch{}
 const main=parserInput.content.querySelector('article,main')||parserInput;
 const content=captureTemplate(article?.content||main.innerHTML);
 sanitizeCaptureFragment(content.content,{base:page.href,assets});
 if(!content.content.textContent.trim())throw new Error('此网页没有可离线读取的正文。网页可能需要登录或依赖脚本加载。');
 sanitizeCaptureFragment(original.content,{base:page.href,assets,snapshot:true});
 const title=(article?.title||fallbackTitle).trim().slice(0,180);
 return {url:page.href,title,byline:(article?.byline||fallbackByline).trim().slice(0,150),
  excerpt:(article?.excerpt||fallbackExcerpt||content.content.textContent.trim()).replace(/\s+/g,' ').trim().slice(0,500),
  contentHtml:content.innerHTML,snapshotHtml:snapshotDocument(original,[...linkedStyles,...styles],title),
  missingImages:(requested.unselectedImages||0)+requested.filter(asset=>asset.kind==='image'&&!assets[asset.url]).length};
}
async function captureWebArticle(url){
 const page=webCaptureUrl(String(url||'').trim());
 if(!page)throw new Error('请输入完整的 HTTP / HTTPS 网页地址。');
 const result=await fetchCaptureData({kind:'page',url:page.href});
 return parseCapturedWebArticle(result.url,result.html,{cacheAssets:true});
}
