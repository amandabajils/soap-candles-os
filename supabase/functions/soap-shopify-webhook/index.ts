import {createClient} from "https://esm.sh/@supabase/supabase-js@2.80.0";
const reply=(status:number,data:unknown)=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json","cache-control":"no-store"}});
Deno.serve(async(req:Request)=>{
 if(req.method!=="POST")return reply(405,{error:"method_not_allowed"});
 const secret=Deno.env.get("SHOPIFY_CLIENT_SECRET")||Deno.env.get("SHOPIFY_WEBHOOK_SECRET");
 const url=Deno.env.get("SUPABASE_URL"),key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
 if(!secret||!url||!key)return reply(503,{error:"not_configured"});
 const topic=req.headers.get("x-shopify-topic")||"";
 const shop=(req.headers.get("x-shopify-shop-domain")||"").toLowerCase();
 const eventId=req.headers.get("x-shopify-event-id")||req.headers.get("x-shopify-webhook-id")||"";
 const signature=req.headers.get("x-shopify-hmac-sha256")||"";
 const allowed=(Deno.env.get("SHOPIFY_SHOP_DOMAIN")||"").toLowerCase();
 if(allowed&&shop!==allowed)return reply(403,{error:"wrong_shop"});
 if(!/^[a-z0-9-]+\.myshopify\.com$/.test(shop)||!eventId||eventId.length>180||!/^[-a-z_\/]+$/.test(topic)||!/^[A-Za-z0-9+/]{43}=$/.test(signature))return reply(401,{error:"invalid_headers"});
 const bytes=new Uint8Array(await req.arrayBuffer());
 if(bytes.length>1500000)return reply(413,{error:"too_large"});
 const hmacKey=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["verify"]);
 const actual=Uint8Array.from(atob(signature),c=>c.charCodeAt(0));
 if(!await crypto.subtle.verify("HMAC",hmacKey,actual,bytes))return reply(401,{error:"invalid_signature"});
 let payload:Record<string,unknown>;
 try{payload=JSON.parse(new TextDecoder().decode(bytes))}catch{return reply(400,{error:"invalid_json"})}
 const db=createClient(url,key,{auth:{persistSession:false}});
 const {error}=await db.from("external_sync_events").insert({provider:"shopify",external_id:eventId,event_type:topic,state:"pending",payload:{shop,order_id:payload.id,order_name:payload.name,created_at:payload.created_at,updated_at:payload.updated_at,financial_status:payload.financial_status,fulfillment_status:payload.fulfillment_status,source:"shopify_webhook"},received_at:new Date().toISOString()});
 if(error&&error.code!=="23505"){console.error("Shopify webhook persistence",error.message);return reply(503,{error:"storage_unavailable"})}
 return reply(200,{received:true});
});