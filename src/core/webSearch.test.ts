import { describe, expect, it } from 'vitest'
import { decodeBingRedirect, parseBingResults, parseDdgResults, stripHtmlToText } from './webSearch'

describe('stripHtmlToText', () => {
  it('去脚本/样式/标签并解实体', () => {
    const html = '<style>.a{}</style><p>你好 &amp; 世界</p><script>var x=1</script><div>第二段</div>'
    expect(stripHtmlToText(html)).toBe('你好 & 世界 第二段')
  })
})

describe('parseBingResults', () => {
  it('解析 b_algo 结果块的标题/链接/摘要', () => {
    const html = `<ol><li class="b_algo"><h2><a href="https://example.com/a" target="_blank">标题<b>一</b></a></h2><p>这是摘要内容</p></li>
    <li class="b_algo"><h2><a href="https://example.org/b">标题二</a></h2><p>摘要二</p></li></ol>`
    const r = parseBingResults(html)
    expect(r).toHaveLength(2)
    expect(r[0]).toEqual({ title: '标题 一', url: 'https://example.com/a', snippet: '这是摘要内容' })
    expect(r[1].url).toBe('https://example.org/b')
  })

  it('必应跳转链接解出真实地址（2026-11-23 实抓页面样本）', () => {
    const redir = 'https://www.bing.com/ck/a?!&&p=c5b9b89f13b36c69d3956d76d10f66ccef2b7a5ef3052ab8d4020f55e446e607JmltdHM9MTc5NTMwNTYwMA&ptn=3&ver=2&hsh=4&fclid=25d62923-5b97-67bd-3323-313a5a996614&u=a1aHR0cHM6Ly93d3cuemhpaHUuY29tL3F1ZXN0aW9uLzU0ODU2ODM5&ntb=1'
    expect(decodeBingRedirect(redir)).toBe('https://www.zhihu.com/question/54856839')
    expect(decodeBingRedirect('https://example.com/direct')).toBe('https://example.com/direct')
  })

  it('无结果时返回空数组', () => {
    expect(parseBingResults('<html><body>没有</body></html>')).toEqual([])
  })
})

describe('parseDdgResults', () => {
  it('解析结果并解开 uddg 跳转链接', () => {
    const html = `<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fsite.example%2Fpage&amp;rut=abc">页面标题</a>
    <a class="result__snippet" href="#">这是一段摘要</a></div>`
    const r = parseDdgResults(html)
    expect(r).toHaveLength(1)
    expect(r[0].url).toBe('https://site.example/page')
    expect(r[0].title).toBe('页面标题')
    expect(r[0].snippet).toBe('这是一段摘要')
  })
})
