export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const apiKey = process.env.GROQ_API_KEY;

  // Feeds organizados por región/tipo
  const feeds = [
    // Hollywood / Industria
    { url: 'https://variety.com/feed/',           source: 'Variety',        region: 'hollywood' },
    { url: 'https://www.indiewire.com/feed/',      source: 'IndieWire',      region: 'autor' },
    { url: 'https://www.hollywoodreporter.com/feed/', source: 'Hollywood Reporter', region: 'hollywood' },
    // Europa
    { url: 'https://cineuropa.org/en/rss/',        source: 'Cineuropa',      region: 'europeo' },
    { url: 'https://www.screendaily.com/rss',      source: 'Screen Daily',   region: 'europeo' },
    // Cine de autor / Arte
    { url: 'https://mubi.com/notebook/posts.atom', source: 'MUBI Notebook',  region: 'autor' },
    // Latinoamérica (usamos feeds generales + filtro por keywords)
    { url: 'https://variety.com/feed/',            source: 'Variety Latino', region: 'latinoamerica' },
    // Asia
    { url: 'https://www.screendaily.com/rss',      source: 'Screen Daily Asia', region: 'asiatico' },
  ];

  const cutoff = Date.now() - 72 * 60 * 60 * 1000; // últimas 72h

  // Keywords por sección
  const sectionKeywords = {
    hollywood:     ['hollywood', 'box office', 'marvel', 'disney', 'netflix', 'streaming', 'blockbuster', 'sequel', 'oscar', 'academy award', 'studio'],
    latinoamerica: ['latin', 'mexico', 'brazil', 'argentina', 'colombia', 'chile', 'peru', 'venezuela', 'cuba', 'spanish', 'latino', 'ibero', 'guadalajara', 'havana', 'bafici'],
    autor:         ['auteur', 'arthouse', 'art house', 'independent', 'indie', 'criterion', 'mubi', 'cannes', 'berlinale', 'venice', 'sundance', 'director', 'palme', 'golden lion'],
    europeo:       ['european', 'france', 'germany', 'italy', 'spain', 'uk', 'british', 'french', 'german', 'italian', 'spanish cinema', 'bafta', 'cesar', 'european film'],
    asiatico:      ['asian', 'korea', 'japan', 'china', 'taiwan', 'hong kong', 'thai', 'india', 'bollywood', 'anime', 'k-drama', 'busan', 'tokyo', 'beijing'],
    africano:      ['africa', 'african', 'nigeria', 'nollywood', 'kenya', 'south africa', 'senegal', 'morocco', 'egypt', 'fespaco', 'carthage'],
  };

  const filmKeywords = ['film', 'movie', 'cinema', 'festival', 'director', 'actor', 'documentary',
    'premiere', 'streaming', 'award', 'auteur', 'foreign', 'animation', 'arthouse', 'criterion',
    'cannes', 'berlinale', 'venice', 'sundance', 'oscar', 'screenplay', 'cinematograph'];

  try {
    const results = await Promise.allSettled(feeds.map(f => fetchRSS(f)));
    let allItems = [];
    results.forEach(r => { if (r.status === 'fulfilled') allItems.push(...r.value); });

    // Filtrar por keywords de cine
    let filtered = allItems.filter(item => {
      const text = (item.title + ' ' + (item.description || '')).toLowerCase();
      return filmKeywords.some(k => text.includes(k));
    });

    // Eliminar duplicados por título similar
    const seen = new Set();
    filtered = filtered.filter(item => {
      const key = item.title.slice(0, 40).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Asignar sección basada en keywords
    filtered = filtered.map(item => {
      const text = (item.title + ' ' + (item.description || '')).toLowerCase();
      let assignedSection = 'hollywood'; // default
      // Prioridad: latinoamerica > asiatico > africano > europeo > autor > hollywood
      for (const section of ['latinoamerica', 'asiatico', 'africano', 'europeo', 'autor']) {
        if (sectionKeywords[section].some(k => text.includes(k))) {
          assignedSection = section;
          break;
        }
      }
      return { ...item, assignedSection };
    });

    filtered.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));
    filtered = filtered.slice(0, 20);

    if (!filtered.length) return res.status(200).json({ articles: [] });

    const articlesText = filtered.map((item, i) =>
      `[${i}] FUENTE: ${item.source} | SECCIÓN: ${item.assignedSection} | TÍTULO: ${item.title} | DESC: ${(item.description || '').slice(0, 250)} | URL: ${item.link || ''} | FECHA: ${item.pubDate || ''}`
    ).join('\n\n');

    const prompt = `Eres periodista de cine para la Academia Otto Salamanca en El Salvador.
Traduce y adapta estas noticias al español latinoamericano. Sé conciso y preciso.

SECCIONES DISPONIBLES: academia, hollywood, latinoamerica, autor, europeo, asiatico, africano

NOTICIAS:
${articlesText}

Responde SOLO con JSON válido sin backticks ni markdown:
{"articles":[
  {
    "index": 0,
    "titleEs": "Título traducido al español",
    "summaryEs": "Resumen de 2 frases en español",
    "section": "hollywood",
    "source": "Nombre del portal",
    "sourceUrl": "URL completa del artículo original",
    "pubDate": "fecha ISO",
    "imageUrl": "",
    "featured": false
  }
]}

REGLAS:
- Traduce TODOS los artículos
- Usa la sección sugerida en SECCIÓN pero corrígela si no corresponde
- El artículo más relevante sobre cine de autor o latinoamericano lleva "featured":true (solo uno)
- sourceUrl debe ser la URL real del artículo para redirigir al lector
- Mantén imageUrl vacío si no hay imagen`;

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 4000,
        temperature: 0.2,
        messages: [{ role: 'user', content: prompt }]
      }),
    });

    const groqData = await groqRes.json();
    const raw = groqData.choices?.[0]?.message?.content || '';
    const cleaned = raw.replace(/^```json\s*/, '').replace(/^```\s*/, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(cleaned);

    if (parsed.articles) {
      parsed.articles = parsed.articles.map(a => ({
        ...a,
        imageUrl: filtered[a.index]?.imageUrl || '',
        sourceUrl: a.sourceUrl || filtered[a.index]?.link || ''
      }));
    }

    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function fetchRSS(feedConfig) {
  const res = await fetch(feedConfig.url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RSS Reader/1.0)' },
    signal: AbortSignal.timeout(7000),
  });
  const xml = await res.text();
  return parseRSS(xml, feedConfig);
}

function parseRSS(xml, feedConfig) {
  const items = [];
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[1];
    const get = (tag) => {
      const m = itemXml.match(new RegExp(
        `<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i'
      ));
      return m ? (m[1] || m[2] || '').trim() : '';
    };
    let imageUrl = '';
    const mediaMatch =
      itemXml.match(/media:content[^>]+url="([^"]+)"/i) ||
      itemXml.match(/enclosure[^>]+url="([^"]+)"/i) ||
      itemXml.match(/<img[^>]+src="([^"]+)"/i);
    if (mediaMatch) imageUrl = mediaMatch[1];

    const title = get('title');
    const link = (get('link') || itemXml.match(/<link>([^<]+)<\/link>/i)?.[1] || '').trim();
    const description = get('description').replace(/<[^>]+>/g, '').slice(0, 400);
    const pubDate = get('pubDate');

    if (title) items.push({
      title, link, description, pubDate, imageUrl,
      source: feedConfig.source, region: feedConfig.region
    });
  }
  return items;
}
