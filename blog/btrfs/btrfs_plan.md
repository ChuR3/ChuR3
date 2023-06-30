# Btrfs

## 基本结构--btree
1. 基本结构：search_for_slot
2. 扩展性：split_leaf  push_left push_right

## NV
1. Btrfs之NV（一）：Copy on Write
2. log_root
3. cow,log_root怎么检查错误(fsck)，怎么处理
4. cow benefit
	- 回溯：btrfs_search_old_slot
	- snapshot

## RAID
1. [Btrfs之RAID(一)：Chunk抽象和使用](./btrfs_raid1.html)
2. [Btrfs之RAID(二)：RAID读写](./btrfs_raid2.html)
3. [Btrfs之RAID(三)：RAID应用](./btrfs_raid3.html)
