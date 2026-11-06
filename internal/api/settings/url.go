package settings

import (
	"net"
	"net/url"
	"strconv"
	"strings"
	"unicode/utf8"
)

// isValidAPIURL 复刻 PUT /api/settings/ai 里 `new URL(apiUrl)` 的「是否抛
// TypeError」判定（WHATWG URL 解析，无 base URL）。
//
// 为什么不用 net/url.Parse：Go 的解析器是 RFC 3986 的宽松实现，会把
// `not-a-url`、`/relative`、`//host/path`、`http://`、` http://x ` 都当成合法
// URL；而 `new URL()` 对前四种抛错、对带首尾空白的第五种反而成功。这里只镜像
// 「通过 / 抛错」这一个可观测结果，不需要 normalization（route.ts 保存的是原始
// 字符串）。
//
// 边界（有意收窄，非 WHATWG 全量对等）：IDNA/Punycode 转换、IPv4 数字形态
// （`http://2130706433/`）、IPvFuture、`file:` 的路径规则都没有复刻——它们都
// 没有出现在本路由的消费者与 e2e 里。下面的规则覆盖 V8 对常见输入的分支：
//   - 必须有 scheme（相对 URL 无 base 时抛错）；
//   - special scheme（http/https/ws/wss/ftp/file）必须能解析出 host，且端口
//     是十进制、≤65535、host 不含 forbidden host code point；
//   - 非 special scheme 的 `scheme:` opaque 形态一律合法（`mailto:` / `a:`）；
//     带 `//` authority 的形态按同一套 host 规则校验（`foo://x y` 抛错）。
func isValidAPIURL(raw string) bool {
	s := normalizeURLInput(raw)
	if s == "" {
		return false
	}

	scheme, rest, ok := splitURLScheme(s)
	if !ok {
		return false
	}
	scheme = strings.ToLower(scheme)

	if isSpecialScheme(scheme) {
		if scheme == "file" {
			// `file:` 与 `file://` 都是合法 URL；host 可以为空。
			return true
		}
		// WHATWG 对 special scheme 忽略任意数量的前导 '/' 与 '\'，之后余下的
		// 就是 authority 起点（`http:example.com` / `http:/example.com` 都合法）。
		rest = strings.TrimLeft(rest, "/\\")
		if rest == "" || rest[0] == '?' || rest[0] == '#' {
			return false
		}
		authority, _ := cutAuthority(rest, true)
		return validAuthority(authority, true)
	}

	if strings.HasPrefix(rest, "//") {
		authority, _ := cutAuthority(rest[2:], false)
		return validAuthority(authority, false)
	}

	// 非 special scheme 的 opaque path：`a:` / `mailto:a@b` / `data:...` 都合法。
	return true
}

// normalizeURLInput 复刻 WHATWG 解析前的两步清洗：先去掉首尾的 C0 控制符与
// 空格（U+0000–U+0020），再删掉串内所有 ASCII tab / LF / CR（V8 把
// `ht\ntp://x` 解析成 http://x）。
func normalizeURLInput(raw string) string {
	start := 0
	for start < len(raw) {
		r, size := utf8.DecodeRuneInString(raw[start:])
		if r > 0x20 {
			break
		}
		start += size
	}
	end := len(raw)
	for end > start {
		r, size := utf8.DecodeLastRuneInString(raw[start:end])
		if r > 0x20 {
			break
		}
		end -= size
	}
	return strings.NewReplacer("\t", "", "\n", "", "\r", "").Replace(raw[start:end])
}

// splitURLScheme 按 URL 文法拆出 scheme:rest；scheme 必须以字母开头，其余是
// 字母/数字/+/-/.。没有冒号或首字符不是字母都算抛错。
func splitURLScheme(s string) (scheme, rest string, ok bool) {
	colon := strings.IndexByte(s, ':')
	if colon <= 0 {
		return "", "", false
	}
	scheme = s[:colon]
	for i := 0; i < len(scheme); i++ {
		b := scheme[i]
		isAlpha := (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z')
		if i == 0 && !isAlpha {
			return "", "", false
		}
		if isAlpha || (b >= '0' && b <= '9') || b == '+' || b == '-' || b == '.' {
			continue
		}
		return "", "", false
	}
	return scheme, s[colon+1:], true
}

func isSpecialScheme(scheme string) bool {
	switch scheme {
	case "http", "https", "ws", "wss", "ftp", "file":
		return true
	}
	return false
}

// cutAuthority 取出 authority（到 '/' '?' '#' 为止；special scheme 额外把 '\'
// 当作分隔符）。返回 authority 与余下部分。
func cutAuthority(s string, backslashIsSeparator bool) (string, string) {
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '/', '?', '#':
			return s[:i], s[i:]
		case '\\':
			if backslashIsSeparator {
				return s[:i], s[i:]
			}
		}
	}
	return s, ""
}

// validAuthority 校验 [userinfo@]host[:port]。
func validAuthority(authority string, hostRequired bool) bool {
	if at := strings.LastIndexByte(authority, '@'); at >= 0 {
		authority = authority[at+1:]
	}

	host, port := authority, ""
	ipv6Literal := false
	if strings.HasPrefix(host, "[") {
		// IPv6 字面量：必须闭合，闭合后只能是空或 :port。
		closeBracket := strings.IndexByte(host, ']')
		if closeBracket < 0 {
			return false
		}
		literal := host[1:closeBracket]
		if net.ParseIP(literal) == nil || !strings.Contains(literal, ":") {
			return false
		}
		ipv6Literal = true
		tail := host[closeBracket+1:]
		switch {
		case tail == "":
		case strings.HasPrefix(tail, ":"):
			port = tail[1:]
		default:
			return false
		}
		host = literal
	} else if colon := strings.LastIndexByte(host, ':'); colon >= 0 {
		port = host[colon+1:]
		host = host[:colon]
	}

	if host == "" {
		if hostRequired {
			return false
		}
	} else if !ipv6Literal && !validHostChars(host) {
		return false
	}

	return validPort(port)
}

// validPort 复刻 URL 解析的端口检查：空端口合法（`http://x:` 解析为无端口），
// 否则必须是十进制且不超过 65535。
func validPort(port string) bool {
	if port == "" {
		return true
	}
	for i := 0; i < len(port); i++ {
		if port[i] < '0' || port[i] > '9' {
			return false
		}
	}
	value, err := strconv.ParseUint(port, 10, 64)
	if err != nil || value > 65535 {
		return false
	}
	return true
}

// validHostChars 检查 forbidden host code point（WHATWG §host parsing）与百分号
// 转义。非 ASCII 字节放行（IDNA 由浏览器/Node 完成，我们只判定「是否抛错」）。
func validHostChars(host string) bool {
	for i := 0; i < len(host); i++ {
		b := host[i]
		switch b {
		case 0x00, '\t', '\n', '\r', ' ', '#', '/', ':', '<', '>', '?', '@', '[', '\\', ']', '^', '|', '"', '{', '}':
			return false
		case '%':
			if i+2 >= len(host) || !isHex(host[i+1]) || !isHex(host[i+2]) {
				return false
			}
		}
		if b >= utf8.RuneSelf {
			// 非 ASCII 主机名（IDN）在 WHATWG 里会先跑 IDNA；放行。
			continue
		}
	}
	return true
}

func isHex(b byte) bool {
	return (b >= '0' && b <= '9') || (b >= 'a' && b <= 'f') || (b >= 'A' && b <= 'F')
}

// trimTrailingSlashes 复刻 `apiUrl.replace(/\/+$/, ”)`。
func trimTrailingSlashes(value string) string {
	return strings.TrimRight(value, "/")
}

// isValidFetchURL 判定 provider 调用用的绝对 URL 能否被 fetch 接受（Node 的
// fetch 对相对地址抛 TypeError "Failed to parse URL from ..."）。这里只要求
// scheme +（special scheme 时）非空 host；错误文案由调用方拼。
func isValidFetchURL(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme == "" {
		return false
	}
	if isSpecialScheme(strings.ToLower(parsed.Scheme)) && parsed.Host == "" && parsed.Opaque == "" {
		return false
	}
	return true
}
