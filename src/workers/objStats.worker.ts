self.onmessage = async (event: MessageEvent<{ text: string }>) => {
  const text = event.data.text;
  let vertices = 0;
  let faces = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('v ')) vertices += 1;
    else if (line.startsWith('f ')) faces += 1;
  }
  self.postMessage({ vertices, faces });
};
