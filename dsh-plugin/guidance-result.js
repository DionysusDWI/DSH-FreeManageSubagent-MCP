/** Receiving IDs alone is insufficient: the whole ID/text pair must be durable. */
export function resultContainsGuidance(event,messages,lookup) {
  const message=event?.data?.message;if(!message || message.isError || !Array.isArray(messages))return false;
  const content=JSON.stringify(message.content ?? '');
  return messages.every(item=> {
    const full=typeof item.text==='string'?item:lookup?.(item.messageId);
    if(!full || full.messageId!==item.messageId || full.seq!==item.seq || typeof full.text!=='string')return false;
    const pair=JSON.stringify('['+item.messageId+'] '+full.text).slice(1,-1);
    return content.includes(pair);
  });
}
