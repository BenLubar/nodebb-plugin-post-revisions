$(window).on('action:topic.loaded', function(e, data) {
	modifyEditIcon(data, data.posts);
});

$(window).on('action:posts.loaded', function(e, data) {
	if (!ajaxify.data.tid) {
		return;
	}

	modifyEditIcon(ajaxify.data, data.posts);
});

$(window).on('action:posts.edited', function(e, data) {
	if (!ajaxify.data.tid) {
		return;
	}

	modifyEditIcon(ajaxify.data, [data.post]);
});

function modifyEditIcon(topic, posts) {
	require(["diff"], function(diff) {
		var isAdminOrMod = topic.privileges.isAdminOrMod;
		posts.forEach(function(post) {
			if (!post.edited && !post.editedISO) {
				return;
			}
	
			var canViewHistory = isAdminOrMod || (post.user && post.user.editHistoryVisible) || post.selfPost;
			var editIcon = $('[component="post"][data-pid="' + post.pid + '"] .edit-icon');
			var editHistoryButton = editIcon.parent();
			if (editHistoryButton.hasClass('post-edit-history-button')) {
				editHistoryButton.off('click').contents().filter(function() {
					return this.nodeType === Node.TEXT_NODE;
				}).remove();
			} else {
				editHistoryButton = editIcon.wrap('<span class="post-edit-history-button" title="view revision history for this post">').parent();
			}
			if (post.revisionCount) {
				editHistoryButton.append(' ' + post.revisionCount);
			}
			if (canViewHistory) {
				editHistoryButton.on('click', function() {
					socket.emit('plugins.postRevisions.get', {pid: post.pid}, function(err, data) {
						if (err) {
							return app.alertError(err);
						}
	
						var canPurge = isAdminOrMod || (topic.privileges['posts:purge'] && post.selfPost);
	
						var historyViewer = $('<div class="post-edit-history-viewer">');
						data.forEach(function(rev) {
							var entry = $('<div>').prependTo($('<div>').prependTo(historyViewer));
							var editor = $('<a>');
							if (rev.user && rev.user.uid) {
								editor.text(' ' + rev.user.username);
								editor.attr('href', '/uid/' + rev.user.uid);
								if (rev.user.picture) {
									$('<img component="user/picture" class="user-img">').attr('data-uid', rev.user.uid).attr('src', rev.user.picture).prependTo(editor);
								} else {
									$('<div class="user-icon">').text(rev.user['icon:text']).css('background-color', rev.user['icon:bgColor']).prependTo(editor);
								}
							} else {
								editor.hide();
							}
							var timestamp = $('<span>');
							if (rev.mode === 'current') {
								timestamp.text('Current version');
							} else if (isNaN(rev.ts)) {
								timestamp.text('Unknown Timestamp');
							} else {
								timestamp.addClass('timeago').attr('title', new Date(rev.ts).toISOString());
							}
							var footer = $('<footer>').append(editor).append(timestamp);
							if (canPurge && rev.mode !== 'current' && rev.mode !== 'unknown') {
								footer.prepend($('<span class="btn btn-xs btn-danger">').text('Purge Revision').on('click', function() {
									if (!confirm('Are you sure you want to purge this revision? This cannot be undone.')) {
										return;
									}
	
									socket.emit('plugins.postRevisions.purge', {pid: post.pid, ts: rev.ts}, function(err) {
										if (err) {
											return app.alertError(err);
										}
	
										entry.remove();
									});
								}));
							}
							entry.parent().append(footer);
							if (rev.mode === 'edit' || rev.mode === 'current') {
								if (rev.topic) {
									entry.append($('<h2>').text(rev.topic.title));
								}
								if (rev.post) {
									entry.append($('<pre>').text(rev.post.content));
								}
							} else if (rev.mode === 'unknown') {
								entry.append($('<em>').text('No further history is available.'));
							}
						});
						var historyBackground = $('<div class="post-edit-history-viewer-background">').append($('<span>').text('Close')).on('click', function() {
							historyViewer.remove();
							historyBackground.remove();
						});
						$('body').append(historyBackground).append(historyViewer);
						historyViewer.find('.timeago').timeago();
						var prevBefore, prevAfter;
						historyViewer.on('scroll', function() {
							var index = Math.round(historyViewer.scrollTop() / historyViewer.get(0).scrollHeight * data.length);
							var before = historyViewer.children().eq(index).children('div');
							var after = historyViewer.children().eq(index + 1).children('div');
							if (before.get(0) == prevBefore) {
								return;
							}
							if (prevBefore) {
								$([prevBefore, prevAfter]).children('h2, pre').each(function() {
									$(this).text($(this).text());
								});
							}
							prevBefore = before.get(0);
							prevAfter = after.get(0);

							['h2', 'pre'].forEach(function(el) {
								var beforeEl = before.children(el);
								var afterEl = after.children(el);
								if (!beforeEl.length || !afterEl.length) {
									return;
								}
								diff.diffWordsWithSpace(beforeEl.text(), afterEl.text(), function(err, elDiff) {
									if (before.get(0) !== prevBefore) {
										return;
									}
									beforeEl.empty();
									afterEl.empty();
									elDiff.forEach(function(part) {
										if (part.added) {
											afterEl.append($('<ins>').text(part.value));
										} else if (part.removed) {
											beforeEl.append($('<del>').text(part.value));
										} else {
											beforeEl.append(document.createTextNode(part.value));
											afterEl.append(document.createTextNode(part.value));
										}
									});
								});
							});
						});
						historyViewer.scrollTop(Number.MAX_SAFE_INTEGER);
						historyViewer.focus().scroll();
					});
				});
			} else {
				editHistoryButton.addClass('disabled');
			}
		});
	});
}
