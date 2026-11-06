package sources

import (
	"bytes"
	"encoding/json"
	"errors"
	"strconv"
)

// 本文件提供「保留键顺序的 JSON 对象」。冻结契约里 config 是 drizzle 的
// mode:'json' 列：route.ts 用对象展开（`{...config, token}`）改写它，键顺序是
// 旧键在前、新键在后。JSON 语义上键序无关紧要，但保持与 route.ts 一致的顺序
// 能让响应 diff 与既有 Next 行为逐字一致，便于切换前对照。

// orderedObject 是按插入顺序序列化的 JSON 对象。
type orderedObject struct {
	keys []string
	vals []json.RawMessage
}

// parseOrderedObject 解析 JSON 对象并保留键顺序。重复键与 JSON.parse 一致：
// 后值覆盖前值，但键位置保持在第一次出现处。
func parseOrderedObject(raw []byte) (orderedObject, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	tok, err := dec.Token()
	if err != nil {
		return orderedObject{}, err
	}
	if delim, ok := tok.(json.Delim); !ok || delim != '{' {
		return orderedObject{}, errors.New("json: not an object")
	}

	var obj orderedObject
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return orderedObject{}, err
		}
		key, ok := keyTok.(string)
		if !ok {
			return orderedObject{}, errors.New("json: object key is not a string")
		}
		var val json.RawMessage
		if err := dec.Decode(&val); err != nil {
			return orderedObject{}, err
		}
		obj.set(key, val)
	}
	if _, err := dec.Token(); err != nil { // 收尾的 '}'
		return orderedObject{}, err
	}
	if dec.More() {
		return orderedObject{}, errors.New("json: trailing data")
	}
	return obj, nil
}

func newOrderedObject() *orderedObject { return &orderedObject{} }

// set 写入或覆盖一个键；已存在的键保持原位置（JS 对象赋值语义）。
func (o *orderedObject) set(key string, val json.RawMessage) {
	for i, k := range o.keys {
		if k == key {
			o.vals[i] = val
			return
		}
	}
	o.keys = append(o.keys, key)
	o.vals = append(o.vals, val)
}

func (o *orderedObject) get(key string) (json.RawMessage, bool) {
	for i, k := range o.keys {
		if k == key {
			return o.vals[i], true
		}
	}
	return nil, false
}

func (o orderedObject) MarshalJSON() ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteByte('{')
	for i, key := range o.keys {
		if i > 0 {
			buf.WriteByte(',')
		}
		encodedKey, err := json.Marshal(key)
		if err != nil {
			return nil, err
		}
		buf.Write(encodedKey)
		buf.WriteByte(':')
		buf.Write(o.vals[i])
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

// maskToken 复刻 `{...config, token: '[ENCRYPTED]'}`：token 已存在时原位覆盖，
// 否则追加到末尾。
//
// config 列的正常数据永远是对象；为了与 JS 的对象展开逐字一致，非对象 JSON 也
// 按展开语义处理：数组与字符串产生索引键，其余标量（null/数字/布尔）不产生自有
// 键。非法 JSON 与 JSON.parse 一样是错误（route.ts 的 catch → 500）。
func maskToken(raw []byte) (json.RawMessage, error) {
	obj, err := parseOrderedObject(raw)
	if err != nil {
		var value any
		if err := json.Unmarshal(raw, &value); err != nil {
			return nil, err
		}
		obj = orderedObject{}
		switch typed := value.(type) {
		case []any:
			for i, item := range typed {
				obj.set(strconv.Itoa(i), mustMarshal(item))
			}
		case string:
			for i, r := range []rune(typed) {
				obj.set(strconv.Itoa(i), mustMarshal(string(r)))
			}
		}
	}
	obj.set("token", json.RawMessage(`"[ENCRYPTED]"`))
	return json.Marshal(obj)
}

func mustMarshal(value any) json.RawMessage {
	encoded, err := json.Marshal(value)
	if err != nil {
		return json.RawMessage("null")
	}
	return encoded
}
