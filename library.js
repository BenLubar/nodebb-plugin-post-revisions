var db = module.parent.require("./database");
var winston = module.parent.require("winston");
var async = module.parent.require("async");
var privileges = module.parent.require("./privileges");
var User = module.parent.require("./user");
var Posts = module.parent.require("./posts");
var SocketPlugins = require.main.require("./src/socket.io/plugins");

SocketPlugins.postRevisions = {
	"get": function(socket, data, callback) {
		var pid = parseInt(data.pid, 10);
		if (pid <= 0) {
			return callback(new Error("[[error:invalid-data]]"));
		}

		async.parallel({
			"isPublic": function(next) {
				async.waterfall([
					function(next) {
						Posts.getPostField(pid, "uid", next);
					},
					function(uid, next) {
						if (!uid) {
							return next(null, {});
						}
						User.getSettings(uid, next);
					},
					function(settings, next) {
						next(null, parseInt(settings.postEditHistoryVisible, 10) === 1);
					}
				], next);
			},
			"isSelf": function(next) {
				async.waterfall([
					function(next) {
						Posts.getPostField(pid, "uid", next);
					},
					function(uid, next) {
						next(null, uid && socket.uid === parseInt(uid, 10));
					},
				], next);
			},
			"isMod": function(next) {
				async.waterfall([
					function(next) {
						Posts.getCidByPid(pid, next);
					},
					function(cid, next) {
						privileges.categories.isAdminOrMod(cid, socket.uid, next);
					}
				], next);
			}
		}, function(err, allowed) {
			if (err) {
				return callback(err);
			}
			if (!allowed.isPublic && !allowed.isSelf && !allowed.isMod) {
				return callback(new Error("[[error:not-allowed]]"));
			}

			var _history;

			async.waterfall([
				function(next) {
					async.parallel({
						"history": function(next) {
							db.getSortedSetRevRangeWithScores("pid:" + pid + ":revisions", 0, -1, next);
						},
						"current": function(next) {
							Posts.getPostData(pid, next);
						}
					}, next);
				},
				function(revisions, next) {
					var oldest = revisions.current;
					var history = [{
						"content": oldest.content,
						"editor": oldest.editor,
						"timestamp": null,
					}];
					revisions.history.forEach(function(rev) {
						var prev = JSON.parse(rev.value);
						history.push({
							"content": prev.content,
							"editor": prev.editor,
							"timestamp": rev.score
						});
						oldest = prev;
					});
					if (oldest.edited) {
						history.push({
							"content": null,
							"editor": null,
							"timestamp": oldest.edited
						});
					}
					next(null, history);
				},
				function(history, next) {
					_history = history;
					Posts.getUserInfoForPosts(history.map(function(rev) {
						return rev.editor;
					}), socket.uid, next);
				},
				function(editors, next) {
					next(null, _history.map(function(rev, i) {
						rev.editor = editors[i];
						return rev;
					}));
				}
			], callback);
		});
	},
	"purge": function(socket, data, callback) {
		var pid = parseInt(data.pid, 10);
		if (pid <= 0) {
			return callback(new Error("[[error:invalid-data]]"));
		}
		var ts = parseInt(data.ts, 10);

		privileges.posts.canPurge(pid, socket.uid, function(err, canPurge) {
			if (err) {
				return callback(err);
			}

			if (!canPurge) {
				return callback(new Error("[[error:not-allowed]]"));
			}

			db.sortedSetsRemoveRangeByScore(["pid:" + pid + ":revisions"], ts, ts, callback);
		});
	}
};

module.exports = {
	"postsModifyUserInfo": function(data, callback) {
		User.getSettings(data.uid, function(err, settings) {
			if (err) {
				return callback(err);
			}

			data.editHistoryVisible = parseInt(settings.postEditHistoryVisible, 10) === 1;

			callback(null, data);
		});
	},
	"postEdit": function(data, callback) {
		Posts.getPostData(data.post.pid, function(err, postData) {
			if (err) {
				return callback(err);
			}

			db.sortedSetAdd("pid:" + data.post.pid + ":revisions", Date.now(), JSON.stringify(postData), function(err) {
				if (err) {
					return callback(err);
				}

				data.post.revisionCount = parseInt(postData.revisionCount || '0', 10) + 1;

				callback(null, data);
			});
		});
	},
	"postPurge": function(data) {
		db.delete("pid:" + data.post.pid + ":revisions", function(err) {
			if (err) {
				winston.error("[plugin/post-revisions] Error purging all post revisions for post " + data.post.pid + ": " + err);
			}
		});
	},
	"userSaveSettings": function(data) {
		db.setObjectField("user:" + data.uid + ":settings", "postEditHistoryVisible", parseInt(data.settings.postEditHistoryVisible, 10) ? "1" : "0", function(err) {
			if (err) {
				winston.error("[plugin/post-revisions] failed to save preference for user " + data.uid + ": " + err);
			}
		});
	},
	"userCustomSettings": function(data, callback) {
		User.getSettings(data.uid, function(err, settings) {
			if (err) {
				return callback(err);
			}

			var checked = parseInt(settings.postEditHistoryVisible, 10) === 1 ? ' checked' : '';

			data.customSettings.push({
				"title": "Post Revisions",
				"content": "<div class='checkbox'><label><input type='checkbox' data-property='postEditHistoryVisible'" + checked + "> <strong>Allow everyone to view old versions of my posts</strong></label></div><p class='help-block'>Applies retroactively. Staff can always see your post edit history. Contact a moderator or administrator if you need to purge a revision of a post.</p>"
			});

			callback(null, data);
		});
	}
};
