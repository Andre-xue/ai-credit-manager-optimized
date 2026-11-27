import { describe, it, expect, beforeEach } from 'vitest'
import {
  parseSteamIdInput, parseResolveVanity, parsePlayerSummary,
  parseOwnedGames, parseRecentlyPlayed, mergeRecentlyPlayed,
  sortLibraryGames, summarizeLibrary, ownedAppidSet,
  buildResolveVanityUrl, buildOwnedGamesUrl,
  type SteamLibraryGame,
} from './steamAccount'

if (!(globalThis as unknown as Record<string, unknown>).localStorage) {
  const store = new Map<string, string>()
  ;(globalThis as unknown as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => { store.clear() },
  }
}
const ls = () => (globalThis as unknown as { localStorage: { clear(): void } }).localStorage
beforeEach(() => { ls().clear() })

describe('parseSteamIdInput', () => {
  it('SteamID64 直填', () => {
    expect(parseSteamIdInput('76561198000000000')).toEqual({ kind: 'id', steamid: '76561198000000000' })
    expect(parseSteamIdInput('  76561198000000000  ')).toEqual({ kind: 'id', steamid: '76561198000000000' })
  })
  it('/profiles/ 链接解析出 id', () => {
    expect(parseSteamIdInput('https://steamcommunity.com/profiles/76561198000000000'))
      .toEqual({ kind: 'id', steamid: '76561198000000000' })
    expect(parseSteamIdInput('https://steamcommunity.com/profiles/76561198000000000/'))
      .toEqual({ kind: 'id', steamid: '76561198000000000' })
  })
  it('/id/ 链接与裸名解析为 vanity', () => {
    expect(parseSteamIdInput('https://steamcommunity.com/id/gabelogannewell'))
      .toEqual({ kind: 'vanity', vanity: 'gabelogannewell' })
    expect(parseSteamIdInput('my_vanity-1')).toEqual({ kind: 'vanity', vanity: 'my_vanity-1' })
  })
  it('认不出的返回 null', () => {
    expect(parseSteamIdInput('')).toBeNull()
    expect(parseSteamIdInput('https://example.com/foo')).toBeNull()
    expect(parseSteamIdInput('12345')).toBeNull()
    expect(parseSteamIdInput('有中文的名字')).toBeNull()
  })
})

describe('parseResolveVanity / parsePlayerSummary', () => {
  it('success=1 取 steamid；42 查无此人返回 null', () => {
    expect(parseResolveVanity({ response: { success: 1, steamid: '76561198000000000' } })).toBe('76561198000000000')
    expect(parseResolveVanity({ response: { success: 42, message: 'No match' } })).toBeNull()
    expect(parseResolveVanity(null)).toBeNull()
  })
  it('资料解析昵称与头像', () => {
    const p = parsePlayerSummary({
      response: { players: [{ steamid: '76561198000000000', personaname: 'Andre', avatarfull: 'https://x/a.jpg' }] },
    }, '76561198000000000')
    expect(p).toEqual({ steamid: '76561198000000000', personaName: 'Andre', avatarUrl: 'https://x/a.jpg' })
    expect(parsePlayerSummary({ response: { players: [] } }, '1')).toBeNull()
  })
  it('接口地址带 key 与目标参数', () => {
    const u = new URL(buildResolveVanityUrl('KEYX', 'someone'))
    expect(u.searchParams.get('key')).toBe('KEYX')
    expect(u.searchParams.get('vanityurl')).toBe('someone')
    const o = new URL(buildOwnedGamesUrl('KEYX', '76561198000000000'))
    expect(o.searchParams.get('include_appinfo')).toBe('true')
    expect(o.searchParams.get('steamid')).toBe('76561198000000000')
  })
})

// fixture：GetOwnedGames 结构（含 rtime_last_played / img_icon_url）
const OWNED = {
  response: {
    game_count: 2,
    games: [
      { appid: 730, name: 'Counter-Strike 2', playtime_forever: 6000, rtime_last_played: 1799000000, img_icon_url: 'abc123' },
      { appid: 570, name: 'Dota 2', playtime_forever: 60, img_icon_url: '' },
    ],
  },
}

describe('parseOwnedGames', () => {
  it('解析全库：时长/最近玩过/封面/图标', () => {
    const r = parseOwnedGames(OWNED)
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.games).toHaveLength(2)
    expect(r.games[0].appid).toBe('730')
    expect(r.games[0].playtimeForever).toBe(6000)
    expect(r.games[0].lastPlayed).toBe(1799000000)
    expect(r.games[0].coverUrl).toContain('/apps/730/header.jpg')
    expect(r.games[0].iconUrl).toContain('/apps/730/abc123.jpg')
    expect(r.games[1].lastPlayed).toBeUndefined()
  })
  it('空 response（隐私未公开）→ unreadable，绝不当空库', () => {
    expect(parseOwnedGames({ response: {} }).status).toBe('unreadable')
    expect(parseOwnedGames({}).status).toBe('unreadable')
    expect(parseOwnedGames(null).status).toBe('unreadable')
  })
  it('games 为空数组是真空库（ok）', () => {
    const r = parseOwnedGames({ response: { game_count: 0, games: [] } })
    expect(r.status).toBe('ok')
    if (r.status === 'ok') expect(r.games).toEqual([])
  })
})

describe('mergeRecentlyPlayed / sortLibraryGames / summarizeLibrary / ownedAppidSet', () => {
  const games: SteamLibraryGame[] = [
    { appid: '1', name: 'Beta', playtimeForever: 120, lastPlayed: 1000, coverUrl: '', iconUrl: '' },
    { appid: '2', name: 'Alpha', playtimeForever: 600, lastPlayed: 500, coverUrl: '', iconUrl: '' },
    { appid: '3', name: 'Gamma', playtimeForever: 30, coverUrl: '', iconUrl: '' },
  ]
  it('近期时长按 appid 并入', () => {
    const merged = mergeRecentlyPlayed(games, new Map([['2', 45]]))
    expect(merged.find(g => g.appid === '2')!.playtime2Weeks).toBe(45)
    expect(merged.find(g => g.appid === '1')!.playtime2Weeks).toBeUndefined()
    expect(parseRecentlyPlayed({ response: { games: [{ appid: 2, playtime_2weeks: 45 }] } }).get('2')).toBe(45)
    expect(parseRecentlyPlayed({ response: {} }).size).toBe(0)
  })
  it('排序：时长/最近/名称', () => {
    expect(sortLibraryGames(games, 'playtime').map(g => g.appid)).toEqual(['2', '1', '3'])
    expect(sortLibraryGames(games, 'recent').map(g => g.appid)).toEqual(['1', '2', '3'])
    expect(sortLibraryGames(games, 'name').map(g => g.appid)).toEqual(['2', '1', '3'])
  })
  it('汇总：总数/总时长小时/近 30 天', () => {
    const now = 1_800_000_000_000
    const gs: SteamLibraryGame[] = [
      { appid: '1', name: 'A', playtimeForever: 90, lastPlayed: Math.floor(now / 1000) - 86400, coverUrl: '', iconUrl: '' },
      { appid: '2', name: 'B', playtimeForever: 30, lastPlayed: Math.floor(now / 1000) - 40 * 86400, coverUrl: '', iconUrl: '' },
    ]
    const s = summarizeLibrary(gs, now)
    expect(s.total).toBe(2)
    expect(s.totalHours).toBe(2)
    expect(s.recent30).toBe(1)
  })
  it('已入库对账：appid 集合', () => {
    const set = ownedAppidSet(games)
    expect(set.has('1')).toBe(true)
    expect(set.has('999')).toBe(false)
  })
})
