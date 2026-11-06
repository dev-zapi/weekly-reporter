package sources

import (
	"encoding/json"
	"fmt"
)

// 本文件复刻 route.ts 里 config 对象的构造与规范化：
//
//	POST: {...validated.config, branchCursors: mapped, ...(aliases)}
//	PUT:  {...validatedConfigWithoutCursors, branches, branchCursors: preserved, ...(aliases)}
//
// 键顺序按 JS 的对象展开 / 赋值语义（覆盖已有键保留原位置，新键追加到末尾），
// 所以这里统一用 orderedObject 而不是 map。

// setRawString 写入一个必填字符串键。
func setRawString(o *orderedObject, key, value string) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return
	}
	o.set(key, encoded)
}

// setOptionalString 复刻 `{...obj, key: value}` 在 value === undefined 时「不加键」。
func setOptionalString(o *orderedObject, key string, value *string) {
	if value == nil {
		return
	}
	setRawString(o, key, *value)
}

func setStringArray(o *orderedObject, key string, values []string) {
	if values == nil {
		values = []string{}
	}
	encoded, err := json.Marshal(values)
	if err != nil {
		return
	}
	o.set(key, encoded)
}

// setBranches 序列化 branches：字符串元素原样、对象元素按 {name, lastCommitTime?}
// （lastCommitTime 缺失时不加键，对应 JS 的 undefined）。
func setBranches(o *orderedObject, key string, entries []branchEntry) {
	items := make([]json.RawMessage, 0, len(entries))
	for _, entry := range entries {
		if entry.IsString {
			encoded, err := json.Marshal(entry.String)
			if err != nil {
				return
			}
			items = append(items, encoded)
			continue
		}
		branch := newOrderedObject()
		setRawString(branch, "name", entry.Name)
		if entry.HasLastCommitTime {
			branch.set("lastCommitTime", marshalNullableString(entry.LastCommitTime))
		}
		encoded, err := json.Marshal(branch)
		if err != nil {
			return
		}
		items = append(items, encoded)
	}
	encoded, err := json.Marshal(items)
	if err != nil {
		return
	}
	o.set(key, encoded)
}

// setNormalizedBranches 序列化归一后的 branches：[{name, lastCommitTime}]，
// lastCommitTime 恒存在、缺失时为 null（`c.lastCommitTime ?? null`）。
func setNormalizedBranches(o *orderedObject, key string, entries []branchCursorEntry) {
	items := make([]json.RawMessage, 0, len(entries))
	for _, entry := range entries {
		cursor := newOrderedObject()
		setRawString(cursor, "name", entry.Name)
		cursor.set("lastCommitTime", marshalNullableString(entry.LastCommitTime))
		encoded, err := json.Marshal(cursor)
		if err != nil {
			return
		}
		items = append(items, encoded)
	}
	encoded, err := json.Marshal(items)
	if err != nil {
		return
	}
	o.set(key, encoded)
}

func marshalNullableString(value *string) json.RawMessage {
	if value == nil {
		return json.RawMessage("null")
	}
	encoded, err := json.Marshal(*value)
	if err != nil {
		return json.RawMessage("null")
	}
	return encoded
}

// preservedBranchCursors 复刻 PUT 的
//
//	existingConfig.branchCursors?.map(c => ({name: c.name, lastCommitTime: c.lastCommitTime ?? null}))
//
// 输入是库里的原始 JSON（无类型约束），所以按 JS 的取值语义逐键处理：
// name 为 undefined 时不加键，lastCommitTime 为 undefined/null 时是 null。
func preservedBranchCursors(raw json.RawMessage) ([]json.RawMessage, bool, error) {
	if len(raw) == 0 {
		return nil, false, nil
	}
	var parsed any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, false, err
	}
	config, _ := parsed.(map[string]any)
	value, present := config["branchCursors"]
	if !present || value == nil {
		return nil, false, nil
	}
	items, ok := value.([]any)
	if !ok {
		return nil, false, fmt.Errorf("collect sources: branchCursors is not an array")
	}
	cursors := make([]json.RawMessage, 0, len(items))
	for _, item := range items {
		cursor := newOrderedObject()
		if object, ok := item.(map[string]any); ok {
			if name, present := object["name"]; present && name != nil {
				encoded, err := json.Marshal(name)
				if err != nil {
					return nil, false, err
				}
				cursor.set("name", encoded)
			}
			lastCommitTime := json.RawMessage("null")
			if value, present := object["lastCommitTime"]; present && value != nil {
				encoded, err := json.Marshal(value)
				if err != nil {
					return nil, false, err
				}
				lastCommitTime = encoded
			}
			cursor.set("lastCommitTime", lastCommitTime)
		} else {
			// `c.name` 对标量是 undefined、对 null 抛 TypeError；两种都落到
			// {lastCommitTime: null} 或 500，这里选择不额外造键。
			cursor.set("lastCommitTime", json.RawMessage("null"))
		}
		encoded, err := json.Marshal(cursor)
		if err != nil {
			return nil, false, err
		}
		cursors = append(cursors, encoded)
	}
	return cursors, true, nil
}

// mergeEditedBranches 移植 src/lib/collect/branches.ts：
// 按名字保留游标、丢空名与重复名，全空时返回「没有配置」。
func mergeEditedBranches(existing json.RawMessage, edited []branchEntry, hasEdited bool) ([]branchCursorEntry, bool, error) {
	if !hasEdited || len(edited) == 0 {
		return nil, false, nil
	}

	cursorByName := map[string]*string{}
	existingEntries, err := rawBranchNames(existing)
	if err != nil {
		return nil, false, err
	}
	for _, entry := range existingEntries {
		if entry.name == "" {
			continue
		}
		if _, ok := cursorByName[entry.name]; ok {
			continue
		}
		cursorByName[entry.name] = entry.lastCommitTime
	}

	result := make([]branchCursorEntry, 0, len(edited))
	for _, entry := range edited {
		name := jsTrim(entry.String)
		if !entry.IsString {
			name = jsTrim(entry.Name)
		}
		if name == "" {
			continue
		}
		if containsBranch(result, name) {
			continue
		}
		result = append(result, branchCursorEntry{Name: name, LastCommitTime: cursorByName[name]})
	}
	if len(result) == 0 {
		return nil, false, nil
	}
	return result, true, nil
}

func containsBranch(entries []branchCursorEntry, name string) bool {
	for _, entry := range entries {
		if entry.Name == name {
			return true
		}
	}
	return false
}

// rawBranch 是库里 branches 数组的一项（字符串或 {name, lastCommitTime}）。
type rawBranch struct {
	name           string
	lastCommitTime *string
}

// rawBranchNames 把库里的 branches 折成 {名字, 游标}。
//
// JS 侧是 `typeof branch === 'string' ? branch.trim() : branch.name.trim()`，对
// 非字符串非对象元素、或 name 不是字符串时会抛 TypeError → 500；这里同样返回错误。
func rawBranchNames(raw json.RawMessage) ([]rawBranch, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	var parsed any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, err
	}
	config, _ := parsed.(map[string]any)
	value, present := config["branches"]
	if !present || value == nil {
		return nil, nil
	}

	var items []any
	switch typed := value.(type) {
	case []any:
		items = typed
	case string:
		// `for (const branch of 'main')` 迭代的是码点；每个码点都是字符串。
		for _, r := range typed {
			items = append(items, string(r))
		}
	default:
		return nil, fmt.Errorf("collect sources: branches is not iterable")
	}

	branches := make([]rawBranch, 0, len(items))
	for _, item := range items {
		switch typed := item.(type) {
		case string:
			branches = append(branches, rawBranch{name: jsTrim(typed)})
		case map[string]any:
			name, ok := typed["name"].(string)
			if !ok {
				return nil, fmt.Errorf("collect sources: branch name is not a string")
			}
			branch := rawBranch{name: jsTrim(name)}
			// `branch.lastCommitTime || null`：空串同样是假值 → null。
			if cursor, ok := typed["lastCommitTime"].(string); ok && cursor != "" {
				value := cursor
				branch.lastCommitTime = &value
			}
			branches = append(branches, branch)
		default:
			return nil, fmt.Errorf("collect sources: branch entry is not a string or object")
		}
	}
	return branches, nil
}
