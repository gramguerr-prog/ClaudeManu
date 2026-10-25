'use strict';

/** Metricas de campanas a partir de envios y eventos. */

function pct(part, total) {
  return total > 0 ? Math.round((part / total) * 1000) / 10 : 0;
}

function campaignStats(store, campaign) {
  const sends = store.find('sends', s => s.campaignId === campaign.id);
  const events = store.find('events', e => e.campaignId === campaign.id);
  const sent = sends.filter(s => s.status === 'sent').length;
  const uniq = type => new Set(events.filter(e => e.type === type).map(e => e.contactId)).size;
  const count = type => events.filter(e => e.type === type).length;

  // Un clic implica apertura aunque el cliente bloquee imagenes.
  const openers = new Set(events.filter(e => e.type === 'open' || e.type === 'click').map(e => e.contactId));
  const uniqueClicks = uniq('click');

  const linkClicks = (campaign.links || []).map((url, index) => {
    const linkEvents = events.filter(e => e.type === 'click' && e.linkIndex === index);
    return { url, clicks: linkEvents.length, unique: new Set(linkEvents.map(e => e.contactId)).size };
  });

  return {
    recipients: campaign.recipients || sends.length,
    queued: sends.filter(s => s.status === 'queued').length,
    sent,
    failed: sends.filter(s => s.status === 'failed').length,
    opens: count('open'),
    uniqueOpens: openers.size,
    clicks: count('click'),
    uniqueClicks,
    unsubscribes: uniq('unsubscribe'),
    bounces: uniq('bounce'),
    openRate: pct(openers.size, sent),
    clickRate: pct(uniqueClicks, sent),
    unsubscribeRate: pct(uniq('unsubscribe'), sent),
    linkClicks,
  };
}

function dashboard(store) {
  const contacts = store.all('contacts');
  const byStatus = status => contacts.filter(c => c.status === status).length;
  const sentCampaigns = store.find('campaigns', c => c.status === 'sent' || c.status === 'sending');
  const recent = sentCampaigns
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    .slice(0, 5)
    .map(c => ({ id: c.id, name: c.name, status: c.status, startedAt: c.startedAt, stats: campaignStats(store, c) }));

  const totals = recent.reduce((acc, c) => {
    acc.sent += c.stats.sent;
    acc.opens += c.stats.uniqueOpens;
    acc.clicks += c.stats.uniqueClicks;
    return acc;
  }, { sent: 0, opens: 0, clicks: 0 });

  const since = Date.now() - 30 * 24 * 3600 * 1000;
  const newSubscribers = contacts.filter(c => c.status === 'subscribed' && new Date(c.createdAt).getTime() >= since).length;

  return {
    lists: store.all('lists').length,
    subscribed: byStatus('subscribed'),
    pending: byStatus('pending'),
    unsubscribed: byStatus('unsubscribed'),
    bounced: byStatus('bounced'),
    newSubscribers,
    campaigns: store.all('campaigns').length,
    avgOpenRate: pct(totals.opens, totals.sent),
    avgClickRate: pct(totals.clicks, totals.sent),
    recent,
  };
}

module.exports = { campaignStats, dashboard };
